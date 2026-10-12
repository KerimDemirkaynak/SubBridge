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
