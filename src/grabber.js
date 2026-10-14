// =========================================================================
// grabber.js - finds the subtitles a web video already has, translates them
// through the background engine and renders them with the subtitle renderer
// in content.js. Runs in the same isolated world as content.js and parsers.js,
// so it shares their globals (settings, parsedSubtitles, parseAnyFile, ...).
// =========================================================================
(() => {
    if (window.__tlGrabber) return;
    window.__tlGrabber = true;

    const isYouTube = /(^|\.)youtube(-nocookie)?\.com$/i.test(location.hostname);

    // Caption boxes that players draw themselves. Hidden while we show the translation...
    const HIDE_SELECTORS = [
        ".jw-text-track-cue", ".vjs-text-track-display", ".plyr__caption", ".art-subtitle-control", ".libass-captions",
        ".shaka-text-container", ".ytp-caption-window-container", ".bmpui-ui-subtitle-overlay", ".player-timedtext", ".vp-captions"
    ];
    // ...and read from in "live" mode, one element per caption box.
    const LIVE_SELECTORS = [
        ".ytp-caption-window-container .caption-window", ".jw-text-track-cue", ".vjs-text-track-display > div > div",
        ".plyr__caption", ".art-subtitle-control", ".libass-captions", ".shaka-text-container",
        ".bmpui-ui-subtitle-label", ".player-timedtext-text-container", ".vp-captions"
    ];
    const PROVIDER_SHORT = { google: "Google", deepl: "DeepL", openai: "OpenAI", anthropic: "Claude", gemini: "Gemini", openrouter: "OpenRouter",
        deepseek: "DeepSeek", groq: "Groq", mistral: "Mistral", xai: "Grok", nvidia: "NVIDIA", custom: "Custom" };

    // ---------- where the AUTOMATIC UI (floating button, auto-start) may appear ----------
    // Streaming services with DRM: their captions can't be pulled, so don't offer a button there.
    const DRM_HOSTS = /(^|\.)(netflix\.com|disneyplus\.com|primevideo\.com|hulu\.com|max\.com|hbomax\.com|tv\.apple\.com|peacocktv\.com|paramountplus\.com)$/i;
    // YouTube: only on a page that actually plays a video (not home, search, channels, ...).
    const YT_PLAYER_PATH = /^\/(watch|shorts\/|embed\/|live\/|clip\/)/;

    function pageSupported() {
        if (isYouTube) return YT_PLAYER_PATH.test(location.pathname);
        return !DRM_HOSTS.test(location.hostname);
    }
    // Is there any sign that THIS video has subtitles we can read? No sign -> no button.
    function hasSubtitleEvidence(video) {
        if (isYouTube) {   // YouTube hides the CC button when a video has no captions
            const b = document.querySelector(".ytp-subtitles-button");
            return !!b && getComputedStyle(b).display !== "none" && b.getAttribute("aria-disabled") !== "true";
        }
        if (sniffed.size) return true;                                   // a subtitle file went over the network
        for (const t of Array.from(video.textTracks || [])) if (t.kind === "subtitles" || t.kind === "captions") return true;
        if (video.querySelector && video.querySelector("track")) return true;   // <track> elements, even if not loaded yet
        for (const sel of LIVE_SELECTORS) {                              // the player is drawing captions right now
            for (const el of document.querySelectorAll(sel)) if ((el.textContent || "").trim()) return true;
        }
        return false;
    }
    // Automatic UI only: manual starts (popup button, Alt+R) are allowed on any page with a visible video.
    const autoUiAllowed = (video) => pageSupported() && hasSubtitleEvidence(video);

    // ---------- translator settings (mirrors the background defaults) ----------
    let tl = { sourceLang: "auto", targetLang: "", batchSize: 40, ctxLines: 3, hideOriginal: true, autoStart: false, provider: "google" };
    const loadTl = () => chrome.storage.local.get("tl").then(d => { Object.assign(tl, d.tl || {}); });
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area === "local" && ch.tl) Object.assign(tl, ch.tl.newValue || {});
    });

    // "Auto-detect -> Türkçe · Google": shown in the toast so a wrong language/engine is obvious.
    function labelLine() {
        const ui = resolveUiLang(settings.uiLang);
        let dn = null;
        try { dn = new Intl.DisplayNames([ui], { type: "language" }); } catch (e) {}
        const nm = (c) => { try { return (dn && dn.of(c)) || c; } catch (e) { return c; } };
        const src = !tl.sourceLang || tl.sourceLang === "auto" ? tr("p_auto_lang") : nm(tl.sourceLang);
        const tgt = nm(tl.targetLang || resolveUiLang("auto"));
        return `${src} → ${tgt} · ${PROVIDER_SHORT[tl.provider] || tl.provider}`;
    }

    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

    // ---------- source 1: subtitle files seen on the network ----------
    const sniffed = new Map();   // url -> {url, cues, at}
    window.addEventListener("message", (e) => {
        const d = e.data;
        if (!d || d.__tlHook !== 1 || e.source !== window) return;
        try {
            const cues = parseAnyFile(d.body, d.url);
            if (cues.length >= 3) {
                sniffed.set(d.url, { url: d.url, cues, at: Date.now() });
                if (sniffed.size > 30) sniffed.delete(sniffed.keys().next().value);
            }
        } catch (err) { /* ignore unparsable */ }
    });

    function currentVideoId() {
        if (!isYouTube) return null;
        try {
            const u = new URL(location.href);
            return u.searchParams.get("v") || (u.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{6,})/) || [])[1] || null;
        } catch (e) { return null; }
    }
    const pickSniffed = () => pickSniffedCues(Array.from(sniffed.values()), { videoId: currentVideoId(), sourceLang: tl.sourceLang });

    // ---------- source 2: native <track> cues ----------
    const restoreModes = [];
    const trackCache = new WeakMap();   // converting 500+ cues (HTML-decoding each) is slow: redo it only when the cue list grows
    function trackCues(t) {
        const n = t.cues ? t.cues.length : 0;
        const hit = trackCache.get(t);
        if (hit && hit.n === n) return hit.cues;
        const cues = n ? Array.from(t.cues).map(c => ({ start: c.startTime, end: c.endTime, text: cleanText(c.text) })).filter(c => c.text) : [];
        trackCache.set(t, { n, cues });
        return cues;
    }
    function collectTrackCandidates(video) {
        const out = [];
        Array.from(video.textTracks || []).forEach((t, i) => {
            if (t.kind !== "subtitles" && t.kind !== "captions") return;
            const wasShowing = t.mode === "showing";
            if (t.mode === "disabled") { restoreModes.push([t, "disabled"]); t.mode = "hidden"; }   // hidden still loads cues
            const cues = trackCues(t);
            if (cues.length) out.push({ url: "track:" + (t.label || t.language || i), lang: (t.language || "").toLowerCase(), label: t.label || "", showing: wasShowing, at: 0, cues });
        });
        return out;
    }
    const sniffedCandidates = () => Array.from(sniffed.values()).map(e => ({ url: e.url, cues: e.cues, at: e.at, lang: "", label: "", showing: false }));

    // The selected entry of a player's subtitle menu (when the menu exists in the page).
    const SELECTED_MENU_SELECTORS = [
        ".jw-settings-submenu-captions [aria-checked='true']", ".jw-settings-captions [aria-checked='true']",
        ".vjs-subtitles-button .vjs-selected", ".vjs-captions-button .vjs-selected",
        ".plyr__menu__container [data-plyr='language'][aria-checked='true']",
        "[class*='subtitle' i] [aria-checked='true']", "[class*='caption' i] [aria-checked='true']",
        "[aria-label*='ubtitle' i] [aria-checked='true']", "[aria-label*='aption' i] [aria-checked='true']"
    ];
    function readSelectedMenuLabels() {
        const out = [];
        for (const sel of SELECTED_MENU_SELECTORS) {
            let els = [];
            try { els = document.querySelectorAll(sel); } catch (e) {}
            els.forEach(el => { const x = (el.textContent || "").replace(/\s+/g, " ").trim(); if (x && x.length < 60) out.push(x); });
        }
        return out;
    }
    // Ask the page's own player object (JW Player / Video.js) through hook-main.js, which runs in the page world.
    function askPagePlayers() {
        return new Promise((resolve) => {
            const id = Math.random().toString(36).slice(2);
            const done = (labels) => { window.removeEventListener("message", onMsg); clearTimeout(timer); resolve(labels || []); };
            const onMsg = (e) => { const d = e.data; if (e.source === window && d && d.__tlSelected === 1 && d.id === id) done(d.labels); };
            const timer = setTimeout(() => done([]), 300);
            window.addEventListener("message", onMsg);
            window.postMessage({ __tlAsk: "selected", id }, "*");
        });
    }

    // What the player is displaying right now (normalised): lets us tell WHICH of several downloaded languages is selected.
    function readDisplayedCaptions(video) {
        const out = [];
        for (const t of Array.from(video.textTracks || [])) {
            if (t.mode === "showing") for (const c of Array.from(t.activeCues || [])) out.push(cleanText(c.text));
        }
        for (const sel of LIVE_SELECTORS) {
            document.querySelectorAll(sel).forEach(el => { const x = readCaptionText(el).trim(); if (x) out.push(x); });
        }
        return out.map(normCaption).filter(Boolean);
    }

    function silenceNativeTracks(video) {
        if (!tl.hideOriginal) return;
        for (const t of Array.from(video.textTracks || [])) {
            if (t.mode === "showing") { restoreModes.push([t, "showing"]); t.mode = "hidden"; }
        }
    }

    // YouTube only downloads a caption file once CC is switched on, so switch it on for a moment.
    function enableYouTubeCaptions() {
        const btn = document.querySelector(".ytp-subtitles-button");
        if (!btn || getComputedStyle(btn).display === "none" || btn.getAttribute("aria-disabled") === "true") return null;
        if (btn.getAttribute("aria-pressed") === "true") return null;   // already on
        btn.click();
        return btn;
    }
    function restoreYouTubeCaptions(btn) {
        try { if (btn && btn.getAttribute("aria-pressed") === "true") btn.click(); } catch (e) {}
    }

    // -> {cues} | null.  With several languages to choose from it WAITS until it can tell which one is selected
    // (the first caption line appears, the user picks one in the player, ...) or the user presses Stop.
    async function findCues(video, id) {
        let ytButton = null;
        if (isYouTube && !pickSniffed()) ytButton = enableYouTubeCaptions();
        const t0 = Date.now();
        const baseDeadline = t0 + (isYouTube ? 7000 : 3200);
        let result = null, small = null, hinted = false;
        while (id === runId) {
            let ambiguous = false, sawShown = false, pool = [];
            if (isYouTube) {
                const c = pickSniffed();
                if (c && c.length >= 3) { result = c; break; }
            } else {
                const shown = readDisplayedCaptions(video);
                sawShown = shown.length > 0;
                const labels = readSelectedMenuLabels().concat(await askPagePlayers());
                const r = chooseCandidate(sniffedCandidates().concat(collectTrackCandidates(video)),
                    { shown, labels, uiLang: resolveUiLang(settings.uiLang), t: video.currentTime, sourceLang: tl.sourceLang });
                ambiguous = r.reason === "ambiguous";
                pool = r.pool;
                if (r.pick) { if (r.pick.cues.length >= 3) { result = r.pick.cues; break; } small = r.pick.cues; }
                // A caption IS on screen for 6 s but matches none of the tracks: use the first one the player loaded.
                if (ambiguous && sawShown && Date.now() > t0 + 6000 && pool.length) { result = pool.slice().sort((a, b) => a.at - b.at)[0].cues; break; }
            }
            if (ambiguous) {
                if (!hinted && Date.now() - t0 > 3500) { hinted = true; showToast(tr("tl_hint_cc")); }   // and keep waiting
            } else if (Date.now() > baseDeadline) break;
            await sleepMs(400);
        }
        if (ytButton) restoreYouTubeCaptions(ytButton);
        if (result) return { cues: result };
        return small ? { cues: small } : null;
    }

    // ---------- rendering through content.js ----------
    let owned = { primary: false, secondary: false };
    function setTrack(target, cues) {
        if (target === "secondary") { parsedSubtitles2 = cues; owned.secondary = true; }
        else { parsedSubtitles = cues; owned.primary = true; }
        const v = getActiveVideo();
        if (v) { (target === "secondary" ? initContainer2 : initContainer)(v); ensureSyncLoop(v); }
    }
    function clearOwnedTracks() {
        if (owned.primary) { parsedSubtitles = []; if (customSubContainer) { customSubContainer.textContent = ""; customSubContainer.style.display = "none"; } }
        if (owned.secondary) { parsedSubtitles2 = []; if (customSubContainer2) { customSubContainer2.textContent = ""; customSubContainer2.style.display = "none"; } }
        owned = { primary: false, secondary: false };
    }
    function hideOriginalCaptions(on) {
        let st = document.getElementById("tl-hide-style");
        if (!on) { if (st) st.remove(); return; }
        if (!st) {
            st = document.createElement("style");
            st.id = "tl-hide-style";
            st.textContent = HIDE_SELECTORS.join(",") + "{visibility:hidden!important}";
            (document.head || document.documentElement).appendChild(st);
        }
    }

    // ---------- run state ----------
    let running = false, runId = 0, liveObs = null, trackListeners = [], hintTimer = null;

    async function start() {
        if (running) return;
        const video = getActiveVideo();
        if (!video) return;
        running = true;
        const id = ++runId;
        setUi("busy");
        try {
            await loadTl();
            showToast(`${tr("tl_scanning")}  ${labelLine()}`);
            if (tl.hideOriginal) hideOriginalCaptions(true);   // before any CC switching, so nothing flashes
            const found = await findCues(video, id);
            if (id !== runId) return;
            const cues = found && found.cues;
            if (tl.hideOriginal) silenceNativeTracks(video);
            if (cues) await translateAll(cues, id);
            else startLive(video, id);
        } catch (e) {
            if (id === runId) fail(e, id);
        }
    }

    function stop() {
        runId++;
        running = false;
        clearTimeout(hintTimer);
        if (liveObs) { liveObs.disconnect(); liveObs = null; }
        trackListeners.forEach(([t, fn]) => t.removeEventListener("cuechange", fn));
        trackListeners = [];
        restoreModes.splice(0).forEach(([t, m]) => { try { t.mode = m; } catch (e) {} });
        hideOriginalCaptions(false);
        clearOwnedTracks();
        setUi("idle");
    }

    function fail(e, id) {
        showToast(tr("tl_err", { msg: String((e && e.message) || e).slice(0, 160) }));
        if (id === runId) stop();
    }

    // ---------- full-file translation (priority = where you are watching) ----------
    async function translateAll(cues, id) {
        const video = getActiveVideo();
        const orig = cues.map(c => ({ start: c.start, end: c.end, text: esc(c.text) }));
        const out = cues.map(c => ({ start: c.start, end: c.end, text: esc(c.text) }));   // shows original until translated
        setTrack("primary", out);
        setTrack("secondary", orig);   // visibility is controlled by the "Show original line" switch

        const size = Math.max(5, Math.min(tl.provider === "google" ? 30 : 80, tl.batchSize | 0 || 40));
        const chunks = [];
        for (let i = 0; i < cues.length; i += size) chunks.push([i, Math.min(cues.length, i + size)]);
        const now = video ? video.currentTime : 0;
        const at = Math.max(0, chunks.findIndex(([, e]) => cues[e - 1].end >= now));
        const order = chunks.slice(at).concat(chunks.slice(0, at).reverse());   // forward first, then back

        let done = 0, failed = false;
        await Promise.all(order.map(async ([a, b]) => {
            const lines = cues.slice(a, b).map(c => c.text);
            const ctx = cues.slice(Math.max(0, a - tl.ctxLines), a).map(c => c.text);
            let res;
            try { res = await chrome.runtime.sendMessage({ type: "TL_TRANSLATE", lines, ctx }); }
            catch (e) { res = { ok: false, error: e.message }; }
            if (id !== runId || failed) return;
            if (!res || !res.ok) { failed = true; fail(new Error(res && res.error || "no response"), id); return; }
            res.out.forEach((t, j) => { if (t) out[a + j].text = esc(t); });   // objects are shared with the renderer
            done++;
            setUi("busy", Math.round(done / chunks.length * 100));
        }));
        if (id !== runId || failed) return;
        setUi("done");
        showToast(`${tr("tl_done", { n: cues.length })}  ${labelLine()}`);
    }

    // ---------- live fallback: translate captions as the player draws them ----------
    // Text of one caption box. YouTube splits a caption into several segment spans.
    function readCaptionText(el) {
        const segs = el.querySelectorAll ? el.querySelectorAll(".ytp-caption-segment") : [];
        if (segs.length) return Array.from(segs).map(s => s.textContent).join(" ");
        return el.innerText || el.textContent || "";
    }

    function startLive(video, id) {
        showToast(`${tr("tl_none")}  ${labelLine()}`);
        setUi("done");
        const tCues = [], oCues = [], history = [];
        setTrack("primary", tCues);
        setTrack("secondary", oCues);
        let lastText = "", lastT = -99, seen = false;

        const handle = (raw) => {
            const text = cleanText(raw);
            const t = video.currentTime;
            if (!text || (text === lastText && Math.abs(t - lastT) < 2)) return;
            seen = true;
            lastText = text; lastT = t;
            const end = t + Math.max(2.5, Math.min(7, text.length * 0.07));
            const entry = { start: t, end, text: esc(text) };
            tCues.push(entry);
            oCues.push({ start: t, end, text: esc(text) });
            const ctx = history.slice(-tl.ctxLines);
            history.push(text);
            chrome.runtime.sendMessage({ type: "TL_TRANSLATE", lines: [text], ctx }).then(res => {
                if (id !== runId) return;
                if (res && res.ok && res.out[0]) entry.text = esc(res.out[0]);
                else if (res && !res.ok) fail(new Error(res.error), id);
            }).catch(() => {});
        };

        // A caption box changes many times while text is typed/rolled in: translate once it has settled for 350 ms.
        const lastSeen = new WeakMap(), timers = new WeakMap();
        const scan = () => {
            for (const sel of LIVE_SELECTORS) {
                document.querySelectorAll(sel).forEach(el => {
                    const text = readCaptionText(el).trim();
                    if (lastSeen.get(el) === text) return;
                    lastSeen.set(el, text);
                    clearTimeout(timers.get(el));
                    if (text) timers.set(el, setTimeout(() => { if (id === runId) handle(text); }, 350));
                });
            }
        };
        liveObs = new MutationObserver(scan);
        liveObs.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
        scan();

        // native tracks that load lazily (e.g. streamed HLS/DASH) via cuechange
        for (const tr0 of Array.from(video.textTracks || [])) {
            if (tr0.kind !== "subtitles" && tr0.kind !== "captions") continue;
            if (tr0.mode === "disabled") { restoreModes.push([tr0, "disabled"]); tr0.mode = "hidden"; }
            const fn = () => Array.from(tr0.activeCues || []).forEach(c => handle(c.text));
            tr0.addEventListener("cuechange", fn);
            trackListeners.push([tr0, fn]);
        }

        // nothing appeared: most likely the site's captions (CC) are switched off
        clearTimeout(hintTimer);
        hintTimer = setTimeout(() => { if (!seen && id === runId) showToast(tr("tl_hint_cc")); }, 8000);
    }

    // ---------- floating button (shadow DOM, anchored to the corner of the video under the pointer) ----------
    let host = null, shadow = null, hideTimer = null, hovering = false;
    function mountUi() {
        if (host) return;
        host = document.createElement("div");
        host.style.cssText = "all:initial;position:fixed;top:12px;right:12px;z-index:2147483647;display:none";
        shadow = host.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = `
            .b{display:flex;gap:4px;font:600 13px system-ui,sans-serif}
            button{all:unset;cursor:pointer;color:#fff;background:linear-gradient(135deg,rgba(99,102,241,.92),rgba(34,211,238,.88));border:0;
                   padding:7px 12px;border-radius:8px;backdrop-filter:blur(6px)}
            button:hover{filter:brightness(1.12)}
            #go.run{background:#7a1f1f}
            #go.ok{box-shadow:0 0 0 2px #3ecf8e}`;
        const bar = document.createElement("div"); bar.className = "b";
        const go = document.createElement("button"); go.id = "go";
        const cfg = document.createElement("button"); cfg.id = "cfg"; cfg.textContent = "\u2699"; cfg.title = tr("tl_settings");
        bar.append(go, cfg); shadow.append(style, bar);
        go.onclick = () => (running ? stop() : start());
        cfg.onclick = () => chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
        bar.addEventListener("mouseenter", () => { hovering = true; clearTimeout(hideTimer); });
        bar.addEventListener("mouseleave", () => { hovering = false; scheduleHide(); });
        document.documentElement.appendChild(host);
        setUi(running ? "done" : "idle");
    }
    function setUi(state, pct) {
        if (!shadow) return;
        const go = shadow.getElementById("go");
        go.className = state === "idle" ? "" : (state === "done" ? "run ok" : "run");
        go.textContent = state === "idle" ? "\uD83C\uDF10 " + tr("tab_translate")
            : state === "done" ? "\u2713 " + tr("tl_stop")
            : (pct != null ? tr("tl_progress", { pct }) : "\u2026") + "  \u2715";
    }
    function scheduleHide() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { if (host && !hovering) host.style.display = "none"; }, 2500);
    }
    // The visible video whose area contains the pointer (and which is big enough to be a "real" player).
    function videoAtPoint(x, y) {
        for (const v of document.querySelectorAll("video")) {
            if (!videoVisibleArea(v)) continue;
            const r = v.getBoundingClientRect();
            if (r.width < 240 || r.height < 120) continue;
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return v;
        }
        return null;
    }
    function placeUiOn(v) {
        const r = v.getBoundingClientRect();
        const vw = window.innerWidth || document.documentElement.clientWidth;
        host.style.top = Math.max(r.top, 0) + 12 + "px";
        host.style.right = Math.max(vw - Math.min(r.right, vw), 0) + 12 + "px";
    }
    let lastMove = 0;
    function onPointer(e) {
        const n = Date.now();
        if (n - lastMove < 120) return;
        lastMove = n;
        const pt = e.touches ? e.touches[0] : e;
        if (!pt) return;
        const v = videoAtPoint(pt.clientX, pt.clientY);
        if (!v || !(running || autoUiAllowed(v))) { if (host && !hovering) scheduleHide(); return; }
        mountUi();
        ensureContainerParent(host);   // keeps the button visible in fullscreen
        placeUiOn(v);
        host.style.display = "block";
        scheduleHide();
    }
    document.addEventListener("mousemove", onPointer, { passive: true, capture: true });
    document.addEventListener("touchstart", onPointer, { passive: true, capture: true });

    // popup/other contexts can drive it too
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
        if (req.type === "TL_TOGGLE" && getActiveVideo() && (!isYouTube || pageSupported())) {
            if (running) stop(); else start();
            sendResponse({ ok: true, running });
        }
    });

    // Alt+R starts / stops translation
    window.addEventListener("keydown", (e) => {
        const a = document.activeElement, tag = a && a.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || (a && a.isContentEditable)) return;
        if (e.altKey && e.code === "KeyR" && getActiveVideo() && (!isYouTube || pageSupported())) { e.preventDefault(); running ? stop() : start(); }
    });

    // SPA navigation to another video: content.js clears the tracks, so end the run too
    let lastHref = location.href;
    setInterval(() => {
        if (location.href === lastHref) return;
        lastHref = location.href;
        if (!isYouTube) sniffed.clear();   // YouTube files are matched by video id instead
        if (running) { stop(); if (tl.autoStart) setTimeout(start, 1500); }
    }, 1000);

    // auto-start when the user opted in
    loadTl().then(() => {
        if (!tl.autoStart) return;
        const t = setInterval(() => {
            const v = getActiveVideo();
            if (v && v.getBoundingClientRect().width >= 240 && autoUiAllowed(v)) { clearInterval(t); start(); }
        }, 1500);
        setTimeout(() => clearInterval(t), 60000);
    });
})();
