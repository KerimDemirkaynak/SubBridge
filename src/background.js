// =========================================================================
// SubBridge - background.js (message router).
// Chrome: service worker (importScripts). Firefox: background script (manifest lists providers.js first).
// =========================================================================
if (typeof importScripts === "function") importScripts("providers.js");

const reply = (p, sendResponse) =>
    p.then(r => sendResponse({ ok: true, ...r }))
     .catch(e => sendResponse({ ok: false, error: String((e && e.message) || e) }));

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.type) {
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
