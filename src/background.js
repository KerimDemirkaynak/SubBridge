// =========================================================================
// SubBridge - background.js (message router).
// Chrome: service worker (importScripts). Firefox: background script (manifest lists scripts.js and providers.js first).
// =========================================================================
if (typeof importScripts === "function") importScripts("scripts.js", "providers.js", "crunchyroll.js");

async function fetchSubtitle(raw, sender) {
    const source = new URL(sender.url || "about:blank");
    const url = SBCrunchyroll.subtitleUrl(raw);
    if (!SBCrunchyroll.host(source.hostname) || !url) throw new Error("Unsupported subtitle host");
    const res = await fetch(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Subtitle HTTP ${res.status}`);
    const max = 5e6;
    if (Number(res.headers.get("content-length")) > max) throw new Error("Subtitle file is too large");
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let bytes = 0, body = "";
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) return { body: body + decoder.decode() };
            bytes += value.byteLength;
            if (bytes > max) { await reader.cancel(); throw new Error("Subtitle file is too large"); }
            body += decoder.decode(value, { stream: true });
        }
    } finally { reader.releaseLock(); }
}

const reply = (p, sendResponse) =>
    p.then(r => sendResponse({ ok: true, ...r }))
     .catch(e => sendResponse({ ok: false, error: String((e && e.message) || e) }));

// Relay metadata between Crunchyroll's watch page and its player frame.
const crPlaybackByTab = new Map();
if (chrome.tabs?.onRemoved) chrome.tabs.onRemoved.addListener(id => crPlaybackByTab.delete(id));
function validPlayback(payload, sender) {
    try {
        if (!SBCrunchyroll.host(new URL(sender.url).hostname) || !Array.isArray(payload?.tracks)) return null;
        const tracks = payload.tracks.slice(0, 100).filter(t => t && SBCrunchyroll.subtitleUrl(t.url)).map(t => ({
            url: SBCrunchyroll.subtitleUrl(t.url), lang: String(t.lang || "").slice(0, 30),
            kind: t.kind === "captions" ? "captions" : "subtitles", label: String(t.label || "").slice(0, 80)
        }));
        if (!tracks.length) return null;
        return { tracks, contentId: String(payload.contentId || "").slice(0, 80),
            audioLocale: String(payload.audioLocale || "").slice(0, 30), pageUrl: sender.url };
    } catch (_) { return null; }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || typeof request.type !== "string") return;
    switch (request.type) {
        case "TL_CR_TRACKS": {
            const payload = validPlayback(request.payload, sender);
            if (!payload || !sender.tab) return;
            crPlaybackByTab.set(sender.tab.id, payload);
            while (crPlaybackByTab.size > 30) crPlaybackByTab.delete(crPlaybackByTab.keys().next().value);
            chrome.tabs.sendMessage(sender.tab.id, { type: "CR_TRACKS", payload }).catch(() => {});
            return;
        }
        case "TL_CR_GET_TRACKS": {
            try {
                if (SBCrunchyroll.host(new URL(sender.url).hostname)) sendResponse({ payload: crPlaybackByTab.get(sender.tab?.id) });
            } catch (_) {}
            return;
        }
        case "TL_FETCH_SUBTITLE":
            reply(fetchSubtitle(request.url, sender), sendResponse);
            return true;
        case "TL_GET_SETTINGS":
            reply(tlGetSettings().then(s => ({ settings: Object.fromEntries(
                ["provider", "sourceLang", "targetLang", "batchSize", "concurrency", "ctxLines", "hideOriginal", "autoStart"].map(k => [k, s[k]])
            ) })), sendResponse);
            return true;
        case "TL_TRANSLATE":
            reply(tlTranslate(request.lines, request.ctx).then(out => ({ out })), sendResponse);
            return true;
        case "TL_LIST_MODELS":
            reply(tlListModels().then(models => ({ models })), sendResponse);
            return true;
        case "TL_TEST":
            reply(tlTest(), sendResponse);
            return true;
        case "TL_CLEAR_CACHE":
            reply(cacheClear().then(() => ({})), sendResponse);
            return true;
        case "OPEN_OPTIONS":
            chrome.runtime.openOptionsPage();
            return;
    }
});
