// =========================================================================
// providers.js - translation engines, request queue, retry/backoff, cache.
// Loaded by background.js (Chrome: importScripts, Firefox: manifest scripts) and by
// the popup / options pages (language lists, defaults, labels).
// API keys are only ever used here, in the background; content scripts never see them.
// =========================================================================

// 40 popular languages, roughly by number of speakers / internet use. Order = display order.
const TL_LANG_NAMES = {
    "en": "English", "zh-CN": "简体中文", "zh-TW": "繁體中文", "hi": "हिन्दी", "es": "Español", "fr": "Français",
    "ar": "العربية", "bn": "বাংলা", "pt": "Português", "ru": "Русский", "ur": "اردو", "id": "Bahasa Indonesia",
    "de": "Deutsch", "ja": "日本語", "tr": "Türkçe", "ko": "한국어", "vi": "Tiếng Việt", "it": "Italiano",
    "fa": "فارسی", "pl": "Polski", "uk": "Українська", "nl": "Nederlands", "th": "ไทย", "ro": "Română",
    "el": "Ελληνικά", "cs": "Čeština", "sv": "Svenska", "hu": "Magyar", "he": "עברית", "ms": "Bahasa Melayu",
    "tl": "Filipino", "ta": "தமிழ்", "te": "తెలుగు", "sw": "Kiswahili", "bg": "Български", "sr": "Српски",
    "hr": "Hrvatski", "da": "Dansk", "fi": "Suomi", "no": "Norsk"
};
const TL_LANGS = Object.keys(TL_LANG_NAMES);

// "Español · Spanish": the native name first so people can find their own language in any UI language.
function tlLangLabel(code, uiLang) {
    let local = "";
    try { local = new Intl.DisplayNames([uiLang || "en"], { type: "language" }).of(code) || ""; } catch (e) {}
    const native = TL_LANG_NAMES[code] || code;
    return !local || local.toLowerCase() === native.toLowerCase() ? native : `${native} · ${local}`;
}

// The browser's own language, mapped to one of our 40 codes (used as the default TARGET language).
function detectBrowserLang() {
    let raw = "en";
    try { raw = (chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || "en"; } catch (e) {}
    const l = String(raw).replace("_", "-").toLowerCase();
    if (l.startsWith("zh")) return /^zh-(tw|hk|mo)|hant/.test(l) ? "zh-TW" : "zh-CN";
    const base = l.split("-")[0];
    const code = ({ nb: "no", nn: "no", fil: "tl", iw: "he", in: "id" })[base] || base;
    return TL_LANGS.includes(code) ? code : "en";
}

// ---------- engines ----------
// "LLM" engines all take a chat-style prompt. Most speak the OpenAI protocol; Gemini and Claude have their own.
const LLM_PRESETS = {
    openai:     { name: "OpenAI (ChatGPT)",  baseUrl: "https://api.openai.com/v1",         model: "gpt-4.1-mini" },
    anthropic:  { name: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com/v1",      model: "claude-haiku-5-5", kind: "anthropic" },
    gemini:     { name: "Google Gemini",      model: "gemini-3.5-flash-lite", kind: "gemini" },
    openrouter: { name: "OpenRouter",         baseUrl: "https://openrouter.ai/api/v1",      model: "google/gemini-2.5-flash" },
    deepseek:   { name: "DeepSeek",           baseUrl: "https://api.deepseek.com/v1",       model: "deepseek-chat" },
    groq:       { name: "Groq",               baseUrl: "https://api.groq.com/openai/v1",    model: "llama-3.3-70b-versatile" },
    mistral:    { name: "Mistral",            baseUrl: "https://api.mistral.ai/v1",         model: "mistral-small-latest" },
    xai:        { name: "xAI (Grok)",         baseUrl: "https://api.x.ai/v1",               model: "grok-3-mini" },
    nvidia:     { name: "NVIDIA",             baseUrl: "https://integrate.api.nvidia.com/v1", model: "meta/llama-3.3-70b-instruct" },
    custom:     { name: "Custom",             baseUrl: "http://localhost:11434/v1",         model: "", keyOptional: true }   // Ollama, LM Studio, any OpenAI-compatible server
};
const LLM_IDS = Object.keys(LLM_PRESETS);
// Dropdown order: free engine, DeepL, then the LLMs.
const TL_PROVIDERS = [{ id: "google", name: "Google Translate" }, { id: "deepl", name: "DeepL" }]
    .concat(LLM_IDS.map(id => ({ id, name: LLM_PRESETS[id].name })));

const TL_DEFAULTS = {
    provider: "google",
    sourceLang: "auto",
    targetLang: "tr",              // replaced by the browser language on first use, see tlGetSettings()
    deepl: { apiKey: "" },
    batchSize: 40,                 // lines per request (the content script caps Google lower)
    concurrency: 2,                // parallel requests
    ctxLines: 3,                   // previous source lines sent as context to LLMs
    glossary: "",                  // "source = target" per line, LLM engines only
    hideOriginal: true,
    autoStart: false
};
for (const id of LLM_IDS) {
    const p = LLM_PRESETS[id];
    TL_DEFAULTS[id] = Object.assign({ apiKey: "", model: p.model }, p.baseUrl ? { baseUrl: p.baseUrl } : {});
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Accepts what people paste: ".../v1/", ".../v1/chat/completions", or just the bare host.
function normBase(u) {
    let b = String(u || "").trim().replace(/\/+$/, "").replace(/\/(chat\/completions|completions|messages|models)$/i, "");
    try {
        const x = new URL(b);
        const path = x.pathname.replace(/\/+$/, "");
        if (/(^|\.)api\.nvidia\.com$/i.test(x.host) && !/\/v\d+$/.test(path)) b = x.origin + "/v1";
        if (/(^|\.)openrouter\.ai$/i.test(x.host) && !/\/api\/v\d+$/.test(path)) b = x.origin + "/api/v1";
        if (/(^|\.)(api\.openai\.com|api\.deepseek\.com|api\.mistral\.ai|api\.x\.ai|api\.anthropic\.com)$/i.test(x.host) && !/\/v\d+$/.test(path)) b = x.origin + "/v1";
        if (/(^|\.)api\.groq\.com$/i.test(x.host) && !/\/openai\/v\d+$/.test(path)) b = x.origin + "/openai/v1";
    } catch (e) { /* leave as typed */ }
    return b;
}

async function tlGetSettings() {
    const { tl } = await chrome.storage.local.get("tl");
    const saved = tl || {};
    const s = Object.assign({}, TL_DEFAULTS, saved);
    s.deepl = Object.assign({}, TL_DEFAULTS.deepl, saved.deepl || {});
    for (const id of LLM_IDS) s[id] = Object.assign({}, TL_DEFAULTS[id], saved[id] || {});

    // The Gemini default changed from gemini-2.5-flash to gemini-3.5-flash-lite. Move people who still have the old
    // default once; the flag is saved along with the settings, so a later deliberate choice of 2.5 sticks.
    if (!saved._gemini35) {
        if (s.gemini.model === "gemini-2.5-flash") s.gemini.model = TL_DEFAULTS.gemini.model;
        s._gemini35 = true;
    }

    // Repair configs that an earlier options-page bug cross-copied between engines.
    const host = (u) => { try { return new URL(u).host; } catch (e) { return ""; } };
    for (const id of LLM_IDS) {
        if (id === "custom" || !s[id].baseUrl) continue;
        for (const other of LLM_IDS) {
            if (other === id || other === "custom" || !LLM_PRESETS[other].baseUrl) continue;
            if (host(s[id].baseUrl) === host(LLM_PRESETS[other].baseUrl)) s[id].baseUrl = TL_DEFAULTS[id].baseUrl;
        }
        s[id].baseUrl = normBase(s[id].baseUrl) || TL_DEFAULTS[id].baseUrl;
    }
    for (const id of LLM_IDS) {
        for (const other of LLM_IDS) {
            if (id !== other && other !== "custom" && id !== "custom" && s[id].model === TL_DEFAULTS[other].model && TL_DEFAULTS[other].model !== TL_DEFAULTS[id].model) s[id].model = TL_DEFAULTS[id].model;
        }
    }

    // Languages: old "zh" -> zh-CN; unknown codes fall back to something sensible.
    if (s.sourceLang === "zh") s.sourceLang = "zh-CN";
    if (s.targetLang === "zh") s.targetLang = "zh-CN";
    if (s.sourceLang !== "auto" && !TL_LANGS.includes(s.sourceLang)) s.sourceLang = "auto";
    if (!saved.targetLang || !TL_LANGS.includes(s.targetLang)) s.targetLang = detectBrowserLang();
    if (s.provider !== "google" && s.provider !== "deepl" && !LLM_PRESETS[s.provider]) s.provider = "google";
    return s;
}

const LLM_LANG_OVERRIDE = { "zh-CN": "Simplified Chinese", "zh-TW": "Traditional Chinese", "tl": "Filipino (Tagalog)", "no": "Norwegian (Bokmål)", "sr": "Serbian (Cyrillic)" };
function langName(code) {
    if (!code || code === "auto") return "the source language (detect it automatically)";
    if (LLM_LANG_OVERRIDE[code]) return LLM_LANG_OVERRIDE[code];
    try { return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code; }
    catch (e) { return code; }
}

// ---------- persistent cache (survives service-worker restarts) ----------
const TL_CACHE_MAX = 40000;
let tlCache = null, tlFlushTimer = null;

async function cacheLoad() {
    if (tlCache) return tlCache;
    const { tlcache } = await chrome.storage.local.get("tlcache");
    tlCache = new Map(Array.isArray(tlcache) ? tlcache : []);
    return tlCache;
}
function cacheFlushSoon() {
    clearTimeout(tlFlushTimer);
    tlFlushTimer = setTimeout(() => {
        while (tlCache.size > TL_CACHE_MAX) tlCache.delete(tlCache.keys().next().value);
        chrome.storage.local.set({ tlcache: [...tlCache] });
    }, 2500);
}
async function cacheClear() {
    tlCache = new Map();
    await chrome.storage.local.remove("tlcache");
}
function cacheKey(s, text) {
    const model = LLM_PRESETS[s.provider] ? s[s.provider].model : "";
    return `${s.provider}|${model}|${s.sourceLang}>${s.targetLang}|${text}`;
}

// ---------- queue: limits parallel requests ----------
let tlLimiter = null, tlLimiterN = 0;
function limiter(n) {
    n = Math.max(1, Math.min(8, n | 0 || 2));
    if (tlLimiter && tlLimiterN === n) return tlLimiter;
    tlLimiterN = n;
    let active = 0;
    const queue = [];
    const pump = () => {
        while (active < n && queue.length) {
            const job = queue.shift();
            active++;
            job.fn().then(job.res, job.rej).finally(() => { active--; pump(); });
        }
    };
    tlLimiter = (fn) => new Promise((res, rej) => { queue.push({ fn, res, rej }); pump(); });
    return tlLimiter;
}

// ---------- fetch with exponential backoff (429 / 5xx / network) ----------
const RETRYABLE = [429, 500, 502, 503, 504];
async function fetchRetry(url, opts, tries = 5) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
        try {
            const r = await fetch(url, opts);
            if (r.ok) return r;
            const body = await r.text().catch(() => "");
            lastErr = new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`);
            lastErr.status = r.status;
            if (!RETRYABLE.includes(r.status)) throw lastErr;
            const ra = parseFloat(r.headers.get("retry-after"));
            await sleep(isFinite(ra) ? ra * 1000 : Math.min(30000, 1000 * 2 ** i) + Math.random() * 500);
        } catch (e) {
            if (e.status && !RETRYABLE.includes(e.status)) throw e;
            lastErr = e;
            if (!e.status) await sleep(Math.min(15000, 800 * 2 ** i));
        }
    }
    throw lastErr;
}

// Prefix errors with engine + full URL so a wrong endpoint is obvious
async function hostTagged(name, url, fn) {
    try { return await fn(); }
    catch (e) {
        const hint = e.status === 404 ? " - check the Base URL and the model name (the ⟳ button lists valid models)" : "";
        e.message = `${name} [${url}]: ${e.message}${hint}`;
        throw e;
    }
}

// ---------- prompt shared by all LLM engines ----------
function llmPrompt(lines, ctx, s) {
    const tgt = langName(s.targetLang);
    const strict = s.strict
        ? `\nCRITICAL: your previous answer was in the wrong language. Every output string MUST be written in ${tgt} (${s.targetLang}) using its normal script. Do not answer in any other language.`
        : "";
    const system =
`You are an expert subtitle translator. Translate from ${langName(s.sourceLang)} to ${tgt} (language code: ${s.targetLang}).
Rules:
- The output language is ALWAYS ${tgt}, whatever language the input or the context is in.
- Write natural, fluent, spoken ${tgt}. Keep tone, humour, register and who is speaking.
- Return exactly one translation per input line, in the same order. Never merge, split, drop or reorder lines.
- Keep line breaks (\\n) inside a line. Keep symbols like ♪ and translate [sound cues].
- Keep names, honorifics and recurring terms consistent. No notes, no explanations.
${s.glossary ? "- Always apply this glossary (source = target):\n" + s.glossary + "\n" : ""}Output ONLY JSON: {"t": ["...", ...]} containing exactly as many strings as input lines.${strict}`;
    const user = JSON.stringify({
        target_language: tgt,
        context_before: (ctx || []).slice(-s.ctxLines),
        count: lines.length,
        lines
    });
    return { system, user };
}

function parseT(text) {
    if (!text) return null;
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "").trim();
    let j;
    try { j = JSON.parse(text); }
    catch (e) {
        const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (!m) return null;
        try { j = JSON.parse(m[0]); } catch (e2) { return null; }
    }
    const a = Array.isArray(j) ? j : (j && j.t);
    return Array.isArray(a) ? a.map(x => String(x == null ? "" : x).trim()) : null;
}

// ---------- engines: each returns string[] (may be the wrong length; the caller validates) ----------
async function googleRaw(lines, s, method) {
    const gc = (c) => (c === "he" ? "iw" : c);   // Google's legacy code for Hebrew
    const q = lines.map(l => l.replace(/\s*\n\s*/g, " ")).join("\n");
    const params = `client=gtx&dt=t&sl=${encodeURIComponent(gc(s.sourceLang))}&tl=${encodeURIComponent(gc(s.targetLang))}`;
    const base = "https://translate.googleapis.com/translate_a/single?";
    const r = method === "GET"
        ? await fetchRetry(base + params + "&q=" + encodeURIComponent(q))
        : await fetchRetry(base + params, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
            body: params + "&q=" + encodeURIComponent(q)      // parameters in the URL *and* the body
        });
    const d = await r.json();
    const txt = (d[0] || []).map(x => x[0] || "").join("");
    await sleep(150 + Math.random() * 250);   // be gentle with the unofficial endpoint
    return txt.split("\n").map(x => x.trim());
}

// DeepL wants its own codes. Not every one of our 40 languages exists there; DeepL then answers with a clear error.
const DEEPL_TARGET = { "en": "EN-US", "pt": "PT-BR", "zh-CN": "ZH-HANS", "zh-TW": "ZH-HANT", "no": "NB" };
const DEEPL_SOURCE = { "zh-CN": "ZH", "zh-TW": "ZH", "no": "NB" };
async function deeplRaw(lines, s) {
    const d = s.deepl;
    if (!d.apiKey) throw new Error("DeepL API key is missing");
    const host = /:fx$/.test(d.apiKey) ? "https://api-free.deepl.com" : "https://api.deepl.com";   // free keys end with ":fx"
    const body = { text: lines, target_lang: DEEPL_TARGET[s.targetLang] || s.targetLang.toUpperCase(), preserve_formatting: true };
    if (s.sourceLang !== "auto") body.source_lang = DEEPL_SOURCE[s.sourceLang] || s.sourceLang.toUpperCase();
    const url = host + "/v2/translate";
    const r = await hostTagged("DeepL", url, () => fetchRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "DeepL-Auth-Key " + d.apiKey },
        body: JSON.stringify(body)
    }));
    const j = await r.json();
    return (j.translations || []).map(t => String(t.text || "").trim());
}

async function geminiRaw(lines, ctx, s) {
    const g = s.gemini;
    if (!g.apiKey) throw new Error("Google Gemini API key is missing");
    const { system, user } = llmPrompt(lines, ctx, s);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(g.model)}:generateContent`;
    const r = await hostTagged("Gemini", url, () => fetchRetry(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": g.apiKey },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: {
                ...(/^gemini-[12][.-]/.test(g.model) ? { temperature: 0.2 } : {}),   // Gemini 3+ deprecates sampling parameters
                responseMimeType: "application/json",
                responseSchema: { type: "OBJECT", properties: { t: { type: "ARRAY", items: { type: "STRING" } } }, required: ["t"] }
            }
        })
    }));
    const d = await r.json();
    const text = (((d.candidates || [])[0] || {}).content || {}).parts;
    return parseT((text || []).map(p => p.text || "").join(""));
}

async function anthropicRaw(lines, ctx, s) {
    const a = s.anthropic;
    if (!a.apiKey) throw new Error("Anthropic API key is missing");
    if (!a.model) throw new Error("Anthropic: model is empty");
    const { system, user } = llmPrompt(lines, ctx, s);
    const url = a.baseUrl.replace(/\/+$/, "") + "/messages";
    const r = await hostTagged("Anthropic", url, () => fetchRetry(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json", "x-api-key": a.apiKey, "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true"   // required for calls that carry a browser Origin
        },
        body: JSON.stringify({ model: a.model, max_tokens: 8192, temperature: 0.2, system, messages: [{ role: "user", content: user }] })
    }));
    const d = await r.json();
    return parseT((d.content || []).map(b => b.text || "").join(""));
}

// OpenAI, OpenRouter, DeepSeek, Groq, Mistral, xAI, NVIDIA and any custom/local server speak the same protocol.
async function openaiRaw(id, lines, ctx, s) {
    const preset = LLM_PRESETS[id], cfg = s[id];
    if (!cfg.apiKey && !preset.keyOptional) throw new Error(`${preset.name} API key is missing`);
    if (!cfg.model) throw new Error(`${preset.name}: model is empty - press ⟳ to list the models`);
    const { system, user } = llmPrompt(lines, ctx, s);
    const url = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const headers = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers["Authorization"] = "Bearer " + cfg.apiKey;
    if (id === "openrouter") headers["X-Title"] = "SubBridge";
    const body = { model: cfg.model, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
    const call = () => hostTagged(preset.name, url, () => fetchRetry(url, { method: "POST", headers, body: JSON.stringify(body) }));
    let r;
    try { r = await call(); }
    catch (e) {
        // Some newer models only accept the default temperature.
        if (e.status === 400 && /temperature/i.test(e.message)) { delete body.temperature; r = await call(); }
        else throw e;
    }
    const d = await r.json();
    return parseT(((((d.choices || [])[0] || {}).message) || {}).content);
}

async function rawTranslate(lines, ctx, s) {
    if (s.provider === "google") return googleRaw(lines, s);
    if (s.provider === "deepl") return deeplRaw(lines, s);
    const preset = LLM_PRESETS[s.provider];
    if (!preset) throw new Error("Unknown engine: " + s.provider);
    if (preset.kind === "gemini") return geminiRaw(lines, ctx, s);
    if (preset.kind === "anthropic") return anthropicRaw(lines, ctx, s);
    return openaiRaw(s.provider, lines, ctx, s);
}

// Guarantees out.length === lines.length: on a count mismatch, split the batch in half and retry.
async function translateLines(lines, ctx, s, depth = 0) {
    const out = await rawTranslate(lines, ctx, s);
    if (out && out.length === lines.length) return out;
    if (lines.length === 1) return [out && out.length ? out.join(" ") : lines[0]];
    if (depth > 6) return lines.slice();
    const mid = lines.length >> 1;
    const a = await translateLines(lines.slice(0, mid), ctx, s, depth + 1);
    const b = await translateLines(lines.slice(mid), (ctx || []).concat(lines.slice(0, mid)), s, depth + 1);
    return a.concat(b);
}

// ---------- "did we get the language we asked for?" ----------
// Catches an engine answering in the wrong language (e.g. Georgian when Turkish was requested) by looking at the script.
async function translateChecked(lines, ctx, s) {
    let out = await translateLines(lines, ctx, s);
    if (scriptShare(out, s.targetLang) >= 0.5) return out;
    // Wrong script: try once more, in a way that differs from the first attempt.
    let retry = null;
    if (s.provider === "google") retry = await googleRaw(lines, s, "GET").catch(() => null);
    else if (s.provider !== "deepl") retry = await translateLines(lines, ctx, Object.assign({}, s, { strict: true }));
    if (retry && retry.length === lines.length && scriptShare(retry, s.targetLang) > scriptShare(out, s.targetLang)) out = retry;
    if (scriptShare(out, s.targetLang) < 0.2) {
        throw new Error(`The engine answered in the wrong language (expected ${langName(s.targetLang)}). Try another model or engine.`);
    }
    return out;
}

async function tlTranslate(lines, ctx) {
    const s = await tlGetSettings();
    const cache = await cacheLoad();
    const out = new Array(lines.length);
    const todo = [];
    lines.forEach((l, i) => {
        const k = cacheKey(s, l);
        if (cache.has(k)) out[i] = cache.get(k); else todo.push(i);
    });
    if (todo.length) {
        const src = todo.map(i => lines[i]);
        const res = await limiter(s.concurrency)(() => translateChecked(src, ctx, s));
        todo.forEach((i, j) => {
            out[i] = res[j];
            if (res[j] && res[j] !== lines[i]) cache.set(cacheKey(s, lines[i]), res[j]);
        });
        cacheFlushSoon();
    }
    return out;
}

// ---------- model listing (so model names never go stale in the UI) ----------
async function tlListModels() {
    const s = await tlGetSettings();
    const preset = LLM_PRESETS[s.provider];
    if (!preset) return [];
    const cfg = s[s.provider];
    if (preset.kind === "gemini") {
        if (!cfg.apiKey) throw new Error("Google Gemini API key is missing");
        const r = await fetchRetry("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
            { headers: { "x-goog-api-key": cfg.apiKey } }, 2);
        const d = await r.json();
        return (d.models || [])
            .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
            .map(m => m.name.replace(/^models\//, ""));
    }
    const url = cfg.baseUrl.replace(/\/+$/, "") + "/models";
    let headers = {};
    if (preset.kind === "anthropic") {
        if (!cfg.apiKey) throw new Error("Anthropic API key is missing");
        headers = { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" };
    } else if (cfg.apiKey) headers = { Authorization: "Bearer " + cfg.apiKey };
    const r = await hostTagged(preset.name, url, () => fetchRetry(url, { headers }, 2));
    const d = await r.json();
    return (d.data || []).map(m => m.id).filter(Boolean).sort();
}

async function tlTest() {
    const s = await tlGetSettings();
    const t0 = Date.now();
    const out = await translateChecked(["Hello, how are you today?", "I'll see you tomorrow."], [], s);
    return { out, ms: Date.now() - t0, lang: s.targetLang };
}
