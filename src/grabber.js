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
    const isCrunchyroll = SBCrunchyroll.host(location.hostname);
    let crPlayback = null, crSignature = "", crLoading = null;

    // Caption boxes that players draw themselves. Hidden while we show the translation...
    const HIDE_SELECTORS = [
        ".jw-text-track-cue", ".vjs-text-track-display", ".plyr__caption", ".art-subtitle-control", ".libass-captions",
        ".shaka-text-container", ".ytp-caption-window-container", ".bmpui-ui-subtitle-overlay", ".player-timedtext", ".vp-captions",
        "#vilosRoot [data-testid='subtitles']", ".vilos-subtitles", ".bmpui-subtitle-region-container", ".libassjs-canvas-parent", ".libassjs-canvas"
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
        if (isCrunchyroll && crPlayback?.tracks.length) return true;
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
    const TL_PUBLIC_DEFAULTS = { sourceLang: "auto", targetLang: "", batchSize: 40, concurrency: 2, ctxLines: 3, hideOriginal: true, autoStart: false, provider: "google" };
    let tl = { ...TL_PUBLIC_DEFAULTS };
    const loadTl = async () => {
        const r = await chrome.runtime.sendMessage({ type: "TL_GET_SETTINGS" });
        if (!r?.ok) throw new Error(r?.error || "Could not load translation settings");
        tl = { ...TL_PUBLIC_DEFAULTS, ...r.settings };
    };
    chrome.storage.onChanged.addListener((ch, area) => {
        if (area !== "local" || !ch.tl) return;
        const restart = running;
        const wasAuto = tl.autoStart;
        if (restart) stop();
        loadTl().then(() => {
            if (!wasAuto && tl.autoStart) autoAttemptKey = null;
            if (restart && getActiveVideo()) start();
        }).catch(e => showToast(String(e.message)));
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
    function acceptPlayback(payload) {
        if (!isCrunchyroll || !payload || !Array.isArray(payload.tracks)) return;
        const watchId = SBCrunchyroll.watchId(location.href);
        if (watchId && payload.contentId && watchId !== payload.contentId) return;
        const tracks = payload.tracks.filter(t => t && typeof t.lang === "string" && SBCrunchyroll.subtitleUrl(t.url)).slice(0, 100);
        if (!tracks.length) return;
        const signature = JSON.stringify([payload.contentId, payload.audioLocale, tracks]);
        if (signature === crSignature) return;
        const restart = running && (liveMode || (crPlayback && (crPlayback.contentId !== payload.contentId || crPlayback.audioLocale !== payload.audioLocale)));
        crPlayback = { ...payload, tracks };
        crSignature = signature;
        crLoading = null;
        if (restart) { stop(); start(); }
    }
    async function crunchyrollCues() {
        if (!crPlayback) return null;
        const selected = SBCrunchyroll.select(crPlayback.tracks, tl.sourceLang, crPlayback.audioLocale);
        if (!selected.length) throw new Error("Crunchyroll has no subtitle track for the selected source language. Choose another language or Auto.");
        const signature = JSON.stringify(selected.map(t => t.url));
        if (!crLoading || crLoading.signature !== signature) {
            const promise = Promise.all(selected.map(async track => {
                const res = await chrome.runtime.sendMessage({ type: "TL_FETCH_SUBTITLE", url: track.url });
                if (!res?.ok) throw new Error(res?.error || "Could not fetch Crunchyroll subtitles");
                const cues = parseAnyFile(res.body, track.url);
                if (!cues.length) throw new Error("Crunchyroll subtitle track has no readable cues");
                return cues;
            })).then(SBCrunchyroll.merge).catch(e => { if (crLoading?.signature === signature) crLoading = null; throw e; });
            crLoading = { signature, promise };
        }
        return crLoading.promise;
    }
    window.addEventListener("message", (e) => {
        const d = e.data;
        if (isCrunchyroll && e.source === window && d?.__tlTracks === 1) {
            acceptPlayback(d);
            chrome.runtime.sendMessage({ type: "TL_CR_TRACKS", payload: d }).catch(() => {});
            return;
        }
        if (!d || d.__tlHook !== 1 || e.source !== window) return;
        if (typeof d.body !== "string" || d.body.length > 5e6 || typeof d.url !== "string") return;
        try {
            const cues = parseAnyFile(d.body, d.url);
            if (cues.length) {
                sniffed.set(d.url, { url: d.url, cues, at: Date.now(), pageKey: currentPageKey() });
                if (sniffed.size > 30) sniffed.delete(sniffed.keys().next().value);
            }
        } catch (err) { /* ignore unparsable */ }
    });
    if (isCrunchyroll) {
        window.postMessage({ __tlAsk: "tracks" }, "*");
        chrome.runtime.sendMessage({ type: "TL_CR_GET_TRACKS" }).then(r => acceptPlayback(r?.payload)).catch(() => {});
    }

    function currentVideoId() {
        if (!isYouTube) return null;
        try {
            const u = new URL(location.href);
            return u.searchParams.get("v") || (u.pathname.match(/\/(?:embed|shorts|live)\/([\w-]{6,})/) || [])[1] || null;
        } catch (e) { return null; }
    }
    const pickSniffed = () => pickSniffedCues(Array.from(sniffed.values()), { videoId: currentVideoId(), sourceLang: tl.sourceLang });

    // ---------- source 2: native <track> cues ----------
    const restoreModes = new Map();
    function setTrackMode(track, mode) {
        if (!restoreModes.has(track)) restoreModes.set(track, track.mode);
        track.mode = mode;
    }
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
            if (t.mode === "disabled") setTrackMode(t, "hidden"); // hidden still loads cues
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
            if (t.mode === "showing") setTrackMode(t, "hidden");
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
        if (isYouTube && !pickSniffed()) { ytButton = enableYouTubeCaptions(); ytEnabledByRun = ytButton; }
        const t0 = Date.now();
        const baseDeadline = t0 + (isYouTube ? 7000 : 3200);
        let result = null, hinted = false;
        while (id === runId) {
            let ambiguous = false;
            if (isCrunchyroll && crPlayback) {
                result = await crunchyrollCues();
                break;
            } else if (isYouTube) {
                const c = pickSniffed();
                if (c?.length) { result = c; break; }
            } else {
                const shown = readDisplayedCaptions(video);
                const labels = readSelectedMenuLabels().concat(await askPagePlayers());
                if (id !== runId) break;
                const r = chooseCandidate(sniffedCandidates().concat(collectTrackCandidates(video)),
                    { shown, labels, uiLang: resolveUiLang(settings.uiLang), t: video.currentTime, sourceLang: tl.sourceLang });
                ambiguous = r.reason === "ambiguous";
                if (r.pick) { result = r.pick.cues; break; }
                if (ambiguous && Date.now() > t0 + 7000) break;
            }
            if (ambiguous) {
                if (!hinted && Date.now() - t0 > 3500) { hinted = true; showToast(tr("tl_hint_cc")); }   // and keep waiting
            } else if (Date.now() > baseDeadline) break;
            await sleepMs(400);
        }
        if (ytButton && (result || id !== runId)) { restoreYouTubeCaptions(ytButton); if (ytEnabledByRun === ytButton) ytEnabledByRun = null; }
        if (result) return { cues: result };
        return null;
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
    let running = false, liveMode = false, runId = 0, liveObs = null, trackListeners = [], hintTimer = null, ytEnabledByRun = null;
    let autoAttemptKey = null, autoNotBefore = 0;
    const autoKey = () => currentPageKey() + "|" + (crPlayback?.contentId || "");

    async function start() {
        if (running) return;
        const video = getActiveVideo();
        if (!video) return;
        running = true;
        const id = ++runId;
        lastHref = currentPageKey();
        lastPageUrl = lastHref;
        autoAttemptKey = autoKey();
        setUi("busy");
        try {
            await loadTl();
            if (id !== runId) return;
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
        liveMode = false;
        clearTimeout(hintTimer);
        if (liveObs) { liveObs.disconnect(); liveObs = null; }
        trackListeners.forEach(([t, event, fn]) => t.removeEventListener(event, fn));
        trackListeners = [];
        restoreModes.forEach((m, t) => { try { t.mode = m; } catch (e) {} });
        restoreModes.clear();
        restoreYouTubeCaptions(ytEnabledByRun);
        ytEnabledByRun = null;
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

        let done = 0, failed = false, next = 0;
        // Pull the next batch only after a worker finishes. Stop/navigation prevents unsent API calls.
        const worker = async () => {
          while (id === runId && !failed && next < order.length) {
            const [a, b] = order[next++];
            const lines = cues.slice(a, b).map(c => c.text);
            const ctx = cues.slice(Math.max(0, a - tl.ctxLines), a).map(c => c.text);
            let res;
            try { res = await chrome.runtime.sendMessage({ type: "TL_TRANSLATE", lines, ctx }); }
            catch (e) { res = { ok: false, error: e.message }; }
            if (id !== runId || failed) return;
            if (!res?.ok || !Array.isArray(res.out) || res.out.length !== lines.length || !res.out.every(t => typeof t === "string")) { failed = true; fail(new Error(res?.error || "Invalid translation response"), id); return; }
            res.out.forEach((t, j) => { if (t) out[a + j].text = esc(t); });   // objects are shared with the renderer
            done++;
            setUi("busy", Math.round(done / chunks.length * 100));
          }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(8, tl.concurrency || 2)) }, worker));
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
        liveMode = true;
        showToast(`${tr("tl_none")}  ${labelLine()}`);
        setUi("done");
        const tCues = [], oCues = [], history = [];
        setTrack("primary", tCues);
        setTrack("secondary", oCues);
        let lastText = "", lastT = -99, seen = false, lastEntry = null;
        let liveActive = 0, latestJob = null;
        const limit = Math.max(1, Math.min(8, tl.concurrency || 2));
        function pumpLive() {
            if (id !== runId || !latestJob || liveActive >= limit) return;
            const job = latestJob;
            latestJob = null;
            if (job.entry.end <= video.currentTime) return;
            liveActive++;
            chrome.runtime.sendMessage({ type: "TL_TRANSLATE", lines: [job.text], ctx: job.ctx }).then(res => {
                if (id !== runId) return;
                if (res?.ok && typeof res.out?.[0] === "string") job.entry.text = esc(res.out[0]);
                else fail(new Error(res?.error || "Invalid translation response"), id);
            }).catch(e => { if (id === runId) fail(e, id); }).finally(() => { liveActive--; pumpLive(); });
        }

        const handle = (raw, start = video.currentTime, endTime = null) => {
            if (id !== runId) return;
            const text = cleanText(raw);
            const t = start;
            if (!text) {
                if (lastEntry && t >= lastEntry.start) lastEntry.end = Math.min(lastEntry.end, t);
                const original = oCues[oCues.length - 1];
                if (original && t >= original.start) original.end = Math.min(original.end, t);
                lastText = "";
                return;
            }
            if (text === lastText && Math.abs(t - lastT) < 2) return;
            if (lastEntry && t >= lastEntry.start) {
                lastEntry.end = Math.min(lastEntry.end, t);
                oCues[oCues.length - 1].end = lastEntry.end;
            }
            seen = true;
            lastText = text; lastT = t;
            const end = endTime ?? t + Math.max(2.5, Math.min(7, text.length * 0.07));
            const entry = { start: t, end, text: esc(text) };
            lastEntry = entry;
            tCues.push(entry);
            oCues.push({ start: t, end, text: esc(text) });
            const ctx = history.slice(-tl.ctxLines);
            history.push(text);
            if (history.length > 10) history.shift();
            if (tCues.length > 4000) { tCues.shift(); oCues.shift(); }
            latestJob = { text, entry, ctx: tl.ctxLines ? ctx : [] };
            pumpLive();
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
                    const start = video.currentTime;
                    if (text) timers.set(el, setTimeout(() => { if (id === runId) handle(text, start); }, 350));
                    else handle("");
                });
            }
        };
        liveObs = new MutationObserver(scan);
        liveObs.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
        scan();

        // native tracks that load lazily (e.g. streamed HLS/DASH) via cuechange
        function listenTrack(tr0) {
            if (!tr0 || (tr0.kind !== "subtitles" && tr0.kind !== "captions")) return;
            if (tl.sourceLang !== "auto") {
                if (String(tr0.language || "").toLowerCase().split("-")[0] !== tl.sourceLang.toLowerCase().split("-")[0]) return;
            } else if ((restoreModes.get(tr0) || tr0.mode) === "disabled") return;
            if (tr0.mode === "disabled") setTrackMode(tr0, "hidden");
            const fn = () => {
                const cues = Array.from(tr0.activeCues || []);
                handle(cues.map(c => c.text).join("\n"), cues.length ? Math.min(...cues.map(c => c.startTime)) : video.currentTime,
                    cues.length ? Math.max(...cues.map(c => c.endTime)) : null);
            };
            tr0.addEventListener("cuechange", fn);
            trackListeners.push([tr0, "cuechange", fn]);
            fn();
        }
        for (const track of Array.from(video.textTracks || [])) listenTrack(track);
        if (video.textTracks?.addEventListener) {
            const add = e => listenTrack(e.track);
            video.textTracks.addEventListener("addtrack", add);
            trackListeners.push([video.textTracks, "addtrack", add]);
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
    const handledToggles = new Set();
    chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
        if (req.type === "CR_TRACKS") { acceptPlayback(req.payload); return; }
        if (req.type === "TL_TOGGLE" && getActiveVideo() && (!isYouTube || pageSupported())) {
            if (!req.requestId || !handledToggles.has(req.requestId)) {
                if (req.requestId) handledToggles.add(req.requestId);
                while (handledToggles.size > 30) handledToggles.delete(handledToggles.values().next().value);
                if (running) stop(); else start();
            }
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
    let lastHref = currentPageKey();
    setInterval(() => {
        const href = currentPageKey();
        if (href !== lastHref) {
            lastHref = href;
            autoNotBefore = Date.now() + 1000;
            if (!isYouTube) for (const [url, entry] of sniffed) if (entry.pageKey !== href) sniffed.delete(url);
            if (isCrunchyroll && crPlayback?.contentId !== SBCrunchyroll.watchId(location.href)) {
                crPlayback = null; crSignature = ""; crLoading = null;
                window.postMessage({ __tlAsk: "tracks" }, "*");
            }
            if (running) stop();
        }
        // Keep watching late-loaded players. A manual Stop suppresses auto-start until the video changes.
        if (tl.autoStart && !running && autoAttemptKey !== autoKey() && Date.now() >= autoNotBefore) {
            const v = getActiveVideo();
            if (v && v.getBoundingClientRect().width >= 240 && autoUiAllowed(v)) start();
        }
    }, 1000);

    loadTl().catch(() => {});
})();
