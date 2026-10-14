// =========================================================================
// parsers.js - turns the subtitle files a player downloads into [{start, end, text}] cues.
// Plain global functions (no DOM state), shared by grabber.js and the unit tests.
// Formats: WebVTT / SRT, ASS/SSA (via content.js parseASS), YouTube "json3" and its XML formats.
// =========================================================================
function cleanText(s) {
    s = String(s || "").replace(/<[^>]*>/g, "").replace(/\{\\[^}]*\}/g, "").replace(/\\N/g, "\n");
    const d = new DOMParser().parseFromString(s, "text/html");
    return (d.body.textContent || "").replace(/[ \t]+/g, " ").trim();
}

function parseTimed(text) {   // WebVTT and SRT
    const cues = [];
    const toS = (h, m, s, ms) => (+h || 0) * 3600 + (+m) * 60 + (+s) + (+ms.padEnd(3, "0")) / 1000;
    const rx = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)\s*-->\s*(?:(\d+):)?(\d+):(\d+)[.,](\d+)/;
    text.replace(/\r/g, "").split(/\n{2,}/).forEach(block => {
        const lines = block.split("\n");
        const i = lines.findIndex(l => rx.test(l));
        if (i < 0) return;
        const m = lines[i].match(rx);
        const t = cleanText(lines.slice(i + 1).join("\n"));
        if (t) cues.push({ start: toS(m[1], m[2], m[3], m[4]), end: toS(m[5], m[6], m[7], m[8]), text: t });
    });
    return cues;
}

// YouTube's own caption format (what the player requests from /api/timedtext).
function parseJson3(body, url) {
    let j;
    try { j = JSON.parse(body); } catch (e) { return []; }
    const cues = [];
    for (const ev of (j && j.events) || []) {
        if (!ev.segs) continue;
        const text = ev.segs.map(s => s.utf8 || "").join("").replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const start = (ev.tStartMs || 0) / 1000;
        cues.push({ start, end: start + (ev.dDurationMs || 2000) / 1000, text });
    }
    cues.sort((a, b) => a.start - b.start);
    // Auto-generated captions roll: every event lasts until long after the next one starts. Cut each at the next start.
    if (/[?&]kind=asr\b/.test(url || "")) {
        for (let i = 0; i < cues.length - 1; i++) if (cues[i + 1].start > cues[i].start && cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
    }
    // merge consecutive duplicates
    const merged = [];
    for (const c of cues) {
        const prev = merged[merged.length - 1];
        if (prev && prev.text === c.text && c.start <= prev.end + 0.05) prev.end = Math.max(prev.end, c.end);
        else merged.push(c);
    }
    return merged;
}

// <transcript><text start="1.2" dur="3.4"> (default) and <timedtext format="3"><body><p t="1200" d="3400"> (srv3)
function parseXmlTimedText(body) {
    const doc = new DOMParser().parseFromString(body, "text/xml");
    const cues = [];
    doc.querySelectorAll("text[start]").forEach(n => {
        const t = cleanText(n.textContent);
        const start = parseFloat(n.getAttribute("start")), dur = parseFloat(n.getAttribute("dur") || "2");
        if (t && isFinite(start)) cues.push({ start, end: start + dur, text: t });
    });
    doc.querySelectorAll("p[t]").forEach(n => {
        const t = cleanText(n.textContent);
        const start = parseFloat(n.getAttribute("t")) / 1000, dur = parseFloat(n.getAttribute("d") || "2000") / 1000;
        if (t && isFinite(start)) cues.push({ start, end: start + dur, text: t });
    });
    return cues.sort((a, b) => a.start - b.start);
}

function parseAnyFile(body, url) {
    const b = String(body).trimStart();
    if (b[0] === "{" && /"events"\s*:/.test(b)) return parseJson3(b, url);
    if (/<(transcript|timedtext)[\s>]/i.test(b.slice(0, 400))) return parseXmlTimedText(b);
    if (/\[Script Info\]/i.test(b) && typeof parseASS === "function") {
        return parseASS(b).subs.map(c => ({ start: c.start, end: c.end, text: cleanText(c.text) })).filter(c => c.text);
    }
    return parseTimed(b);
}

// Which of the subtitle files seen on the network should be translated?
// entries: [{url, cues, at}]  opts: {videoId, sourceLang}
function pickSniffedCues(entries, opts) {
    const o = opts || {};
    let list = entries.slice();
    if (o.videoId) {   // SPA sites like YouTube keep files of earlier videos around: only take this video's
        list = list.filter(x => { try { return new URL(x.url, "https://x.invalid/").searchParams.get("v") === o.videoId; } catch (e) { return false; } });
    }
    list = list.filter(x => !/[?&]tlang=/.test(x.url));   // YouTube's own machine translation is not the original
    if (!list.length) return null;
    const want = o.sourceLang && o.sourceLang !== "auto" ? o.sourceLang.toLowerCase().split("-")[0] : null;
    const byLang = want ? list.filter(x => { const m = x.url.match(/[?&]lang=([\w-]+)/); return m && m[1].toLowerCase().startsWith(want); }) : [];
    const pool = byLang.length ? byLang : list;
    // a video-specific site: the most recent request is the track the player is using now; elsewhere: the fullest file
    pool.sort((a, b) => o.videoId ? b.at - a.at : b.cues.length - a.cues.length);
    return pool[0].cues;
}

// =========================================================================
// Which subtitle track is "the one"? A player often downloads EVERY language and shows one of them.
// Candidates: [{url, cues, at, lang, label, showing}]  (files seen on the network and native <track>s).
// =========================================================================
function normCaption(s) {
    return String(s || "").toLowerCase().replace(/<[^>]*>/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// The same track often shows up twice (the player downloads a .vtt AND exposes it as a <track>): merge those.
function dedupeCandidates(cands) {
    const out = new Map();
    for (const c of cands) {
        if (!c.cues.length) continue;
        const sig = `${c.cues.length}|${normCaption(c.cues[0].text)}|${normCaption(c.cues[c.cues.length >> 1].text)}`;
        const prev = out.get(sig);
        if (!prev) { out.set(sig, Object.assign({}, c)); continue; }
        prev.showing = prev.showing || c.showing;
        prev.lang = prev.lang || c.lang;
        prev.label = prev.label || c.label;
        prev.at = Math.min(prev.at, c.at);
    }
    return Array.from(out.values());
}

// How many of the lines the player is showing right now also appear (at about this time) in this track?
function scoreAgainstDisplayed(cand, shownNorm, t) {
    let score = 0;
    for (const c of cand.cues) {
        if (c.end < t - 8 || c.start > t + 8) continue;
        const n = normCaption(c.text);
        if (!n) continue;
        for (const sh of shownNorm) {
            if (n === sh || (sh.length >= 4 && n.length >= 4 && (n.includes(sh) || sh.includes(n)))) { score++; break; }
        }
    }
    return score;
}

const LANG_TOKENS = {
    en: ["en", "eng", "english"], ja: ["ja", "jpn", "jp", "japanese"], zh: ["zh", "chi", "zho", "chs", "cht", "chinese"],
    ko: ["ko", "kor", "korean"], es: ["es", "spa", "spanish"], fr: ["fr", "fre", "fra", "french"], de: ["de", "ger", "deu", "german"],
    it: ["it", "ita", "italian"], pt: ["pt", "por", "portuguese"], ru: ["ru", "rus", "russian"], ar: ["ar", "ara", "arabic"],
    tr: ["tr", "tur", "turkish"], hi: ["hi", "hin", "hindi"], id: ["id", "ind", "indonesian"], vi: ["vi", "vie", "vietnamese"], th: ["th", "tha", "thai"]
};
// How sure are we that this candidate is in language `want`?  2 = its track language / file name says so,
// 1 = only its writing system fits (Chinese and Japanese share Han, so that is weak), 0 = no sign.
function candidateLangStrength(c, want) {
    const base = String(want).toLowerCase().split("-")[0];
    if (c.lang && String(c.lang).toLowerCase().startsWith(base)) return 2;
    const hay = `${c.url || ""} ${c.label || ""}`.toLowerCase();
    if ((LANG_TOKENS[base] || [base]).some(n => new RegExp("(^|[^a-z])" + n + "([^a-z]|$)").test(hay))) return 2;
    if (typeof scriptShare === "function" && typeof LANG_SCRIPT !== "undefined" && LANG_SCRIPT[want] && LANG_SCRIPT[want] !== "Latin") {
        const texts = c.cues.slice(0, 80).map(x => x.text);
        if (scriptShare(texts, want) < 0.5) return 0;
        // Chinese and Japanese both write Han characters: tell them apart by kana (only Japanese has it).
        const kana = kanaShare(texts);
        if (base === "ja") return kana >= 0.05 ? 1 : 0;
        if (base === "zh") return kana < 0.02 ? 1 : 0;
        return 1;
    }
    return 0;
}
function kanaShare(texts) {
    let total = 0, kana = 0;
    for (const ch of texts.join(" ")) {
        if (!/\p{L}/u.test(ch)) continue;
        total++;
        if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) kana++;
    }
    return total ? kana / total : 0;
}
const candidateIsLang = (c, want) => candidateLangStrength(c, want) > 0;
// strong evidence wins; weak (script only) evidence is used only when nothing is strong
function filterByLang(pool, want) {
    const strong = pool.filter(c => candidateLangStrength(c, want) === 2);
    return strong.length ? strong : pool.filter(c => candidateLangStrength(c, want) === 1);
}

// Which language does a menu label ("English", "Chinese - Traditional", "Español", "日本語") name? -> base codes
function langCodesFromLabel(label, uiLang) {
    const L = " " + normCaption(label) + " ";
    if (L.trim() === "" || /^ (off|none|disabled) $/.test(L)) return [];
    const codes = typeof LANG_SCRIPT !== "undefined" ? Object.keys(LANG_SCRIPT) : [];
    const found = [];
    for (const b of Array.from(new Set(codes.map(c => c.split("-")[0])))) {
        const names = new Set();
        for (const loc of ["en", uiLang || "en", b]) {   // English name, name in the UI language, and the language's own name
            try { const n = new Intl.DisplayNames([loc], { type: "language" }).of(b); if (n) names.add(normCaption(n)); } catch (e) {}
        }
        if (Array.from(names).some(n => n.length >= 2 && L.includes(" " + n + " "))) found.push(b);
    }
    return found;
}
function candidatesForLabel(pool, label, uiLang) {
    const bases = langCodesFromLabel(label, uiLang);
    if (!bases.length) return [];
    const full = (b) => (typeof LANG_SCRIPT !== "undefined" && LANG_SCRIPT[b]) ? b : (b === "zh" ? "zh-CN" : b);
    let out = [];
    for (const b of bases) out = out.concat(filterByLang(pool, full(b)));
    out = Array.from(new Set(out));
    if (out.length > 1 && bases.includes("zh")) {   // Traditional / Simplified Chinese
        const L = String(label).toLowerCase();
        const trad = /tradition|繁|hant|\btw\b|\bhk\b|taiwan|hong ?kong/.test(L), simp = /simplif|简|簡|hans|\bcn\b|mainland/.test(L);
        const re = trad ? /(^|[^a-z])(tw|hk|cht|hant|trad\w*)([^a-z]|$)/ : simp ? /(^|[^a-z])(cn|chs|hans|simp\w*)([^a-z]|$)/ : null;
        if (re) { const n = out.filter(c => re.test(`${c.url || ""} ${c.label || ""}`.toLowerCase())); if (n.length) out = n; }
    }
    return out;
}

// ctx: {shown: [normalised text the player displays now], t: currentTime, sourceLang}
// -> {pick, reason}   reason: none | single | showing | selected | displayed | lang | ambiguous (pick is null, pool lists the contenders)
function chooseCandidate(cands, ctx) {
    let pool = dedupeCandidates(cands);
    if (!pool.length) return { pick: null, reason: "none", pool };
    if (pool.length === 1) return { pick: pool[0], reason: "single", pool };

    const showing = pool.filter(c => c.showing);                       // a native track the player has switched on
    if (showing.length === 1) return { pick: showing[0], reason: "showing", pool };

    for (const label of ctx.labels || []) {                            // the player / its CC menu says which language is selected
        const m = candidatesForLabel(pool, label, ctx.uiLang);
        if (m.length === 1) return { pick: m[0], reason: "selected", pool };
        if (m.length > 1) pool = m;
    }

    if (ctx.shown && ctx.shown.length) {                               // the caption on screen identifies the language
        const scored = pool.map(c => ({ c, s: scoreAgainstDisplayed(c, ctx.shown, ctx.t || 0) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
        if (scored.length === 1 || (scored.length > 1 && scored[0].s > scored[1].s)) return { pick: scored[0].c, reason: "displayed", pool };
        if (scored.length > 1) pool = scored.filter(x => x.s === scored[0].s).map(x => x.c);
    }
    if (ctx.sourceLang && ctx.sourceLang !== "auto") {                 // the user said which language the video is in
        const matching = filterByLang(pool, ctx.sourceLang);
        if (matching.length === 1) return { pick: matching[0], reason: "lang", pool };
        if (matching.length > 1) pool = matching;
    }
    return { pick: null, reason: "ambiguous", pool };
}
