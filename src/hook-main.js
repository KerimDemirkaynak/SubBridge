// Runs in the PAGE's own JS world (manifest "world": "MAIN") so it can see the
// player's network traffic. It only forwards subtitle-looking responses to the
// extension's content script via window.postMessage. Nothing else leaves the page.
(() => {
    if (window.__tlHook) return;
    window.__tlHook = true;
    const URL_RX = /\.(vtt|srt|ass|ssa)(\?|#|$)|[?&](format|fmt)=(vtt|srt|json3|srv\d)|\/(subtitles?|captions?|tracks?)\/|timedtext/i;
    const BODY_RX = /-->|\[Script Info\]|"events"\s*:|<transcript|<timedtext/;
    const isCR = SBCrunchyroll.host(location.hostname);
    let playback = null;
    const sendPlayback = () => {
        if (playback) window.postMessage({ __tlTracks: 1, ...playback }, "*");
    };
    function playbackRequest(raw) {
        if (!isCR) return false;
        try {
            const u = new URL(raw, location.href);
            return SBCrunchyroll.apiHost(u.hostname) && /\/play(?:\?|$)|\/playback\/v\d+\//i.test(u.pathname);
        } catch (_) { return false; }
    }
    function scanPlayback(url, body) {
        if (typeof body !== "string" || body.length > 3e6) return;
        try {
            const data = SBCrunchyroll.extract(JSON.parse(body), new URL(url, location.href).href);
            if (!data.tracks.length) return;
            playback = { ...data, pageUrl: location.href };
            sendPlayback();
        } catch (_) {}
    }
    async function readSmall(response, max) {
        if (!response.ok || Number(response.headers.get("content-length")) > max) return "";
        const reader = response.body?.getReader();
        if (!reader) return (await response.text()).slice(0, max);
        let size = 0, text = "";
        const decoder = new TextDecoder();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) return text + decoder.decode();
                size += value.byteLength;
                if (size > max) { await reader.cancel(); return ""; }
                text += decoder.decode(value, { stream: true });
            }
        } finally { reader.releaseLock(); }
    }
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
            const cr = playbackRequest(String(u));
            if (URL_RX.test(String(u)) || cr) {
                p.then(r => readSmall(r.clone(), cr ? 3e6 : 5e6).then(b => {
                    if (cr) scanPlayback(u, b); else post(u, b);
                })).catch(() => {});
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
    const onLoad = function () {
        try {
            const cr = playbackRequest(String(this.__tlUrl));
            let body = "";
            if (this.responseType === "" || this.responseType === "text") body = this.responseText;
            else if (cr && this.responseType === "json") body = JSON.stringify(this.response);
            if (cr) scanPlayback(this.__tlUrl, body); else post(this.__tlUrl, body);
        } catch (_) {}
    };
    XMLHttpRequest.prototype.send = function () {
        try {
            this.removeEventListener("load", onLoad);
            if (URL_RX.test(String(this.__tlUrl)) || playbackRequest(String(this.__tlUrl))) this.addEventListener("load", onLoad);
        } catch (e) {}
        return origSend.apply(this, arguments);
    };

    // The content script lives in an isolated world and cannot see page JS objects.
    // Players like JW Player and Video.js know exactly which subtitle track is switched on: let it ask.
    function selectedFromPlayers() {
        const out = [];
        try {   // JW Player: index 0 of the captions list is "Off"
            if (typeof window.jwplayer === "function") {
                const p = window.jwplayer();
                if (p && typeof p.getCaptionsList === "function" && typeof p.getCurrentCaptions === "function") {
                    const list = p.getCaptionsList(), i = p.getCurrentCaptions();
                    if (Array.isArray(list) && i > 0 && list[i]) out.push(String(list[i].label || list[i].id || ""));
                }
            }
        } catch (e) {}
        try {   // Video.js
            if (window.videojs && typeof window.videojs.getPlayers === "function") {
                for (const pl of Object.values(window.videojs.getPlayers())) {
                    if (!pl || typeof pl.textTracks !== "function") continue;
                    const tt = pl.textTracks();
                    for (let i = 0; i < tt.length; i++) {
                        const t = tt[i];
                        if ((t.kind === "subtitles" || t.kind === "captions") && t.mode === "showing") out.push(String(t.label || t.language || ""));
                    }
                }
            }
        } catch (e) {}
        return out.filter(Boolean);
    }
    window.addEventListener("message", (e) => {
        const d = e.data;
        if (e.source !== window || !d) return;
        if (d.__tlAsk === "tracks") { sendPlayback(); return; }
        if (d.__tlAsk !== "selected") return;
        window.postMessage({ __tlSelected: 1, id: d.id, labels: selectedFromPlayers() }, "*");
    });
})();
