// Runs in the PAGE's own JS world (manifest "world": "MAIN") so it can see the
// player's network traffic. It only forwards subtitle-looking responses to the
// extension's content script via window.postMessage. Nothing else leaves the page.
(() => {
    if (window.__tlHook) return;
    window.__tlHook = true;
    const URL_RX = /\.(vtt|srt|ass|ssa)(\?|#|$)|[?&](format|fmt)=(vtt|srt|json3|srv\d)|\/(subtitles?|captions?|tracks?)\/|timedtext/i;
    const BODY_RX = /-->|\[Script Info\]|"events"\s*:|<transcript|<timedtext/;
    const post = (url, body) => {
        try {
            if (typeof body === "string" && body.length < 5e6 && BODY_RX.test(body)) {
                window.postMessage({ __tlHook: 1, url: String(url), body }, "*");
            }
        } catch (e) {}
    };

    const origFetch = window.fetch;
    window.fetch = function (...args) {
        const p = origFetch.apply(this, args);
        try {
            const u = (args[0] && args[0].url) || args[0];
            if (URL_RX.test(String(u))) {
                p.then(r => r.clone().text().then(b => post(u, b)).catch(() => {})).catch(() => {});
            }
        } catch (e) {}
        return p;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
        this.__tlUrl = u;
        return origOpen.apply(this, arguments);
    };
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
        try {
            if (URL_RX.test(String(this.__tlUrl))) {
                this.addEventListener("load", () => {
                    if (this.responseType === "" || this.responseType === "text") post(this.__tlUrl, this.responseText);
                });
            }
        } catch (e) {}
        return origSend.apply(this, arguments);
    };
})();
