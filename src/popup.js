// =========================================================================
// SubBridge - popup.js
// Tabs: Translate (engine/keys/languages), Style, Original line, Site, Keys.
// providers.js is loaded first: it gives us tlGetSettings() and TL_LANGS.
// =========================================================================
document.addEventListener("DOMContentLoaded", async () => {
    const $ = (id) => document.getElementById(id);
    let uiPref = "auto", currentLang = "en";
    let S = await tlGetSettings();

    const STYLE_KEYS = [
        "aspectMode","subSize","subOpacity","subColor","borderColor","borderWidth","shadowLevel","subFont",
        "edgeBottom","posOffsetX","posOffsetY","dragMode","positionTop",
        "subColor2","subSize2","subOpacity2","subFont2","borderColor2","borderWidth2","shadowLevel2","dualGap","siteProfiles"
    ];
    const SITE_KEYS = ["subSize","subOpacity","subColor","borderColor","borderWidth","shadowLevel","subFont","edgeBottom","aspectMode"];

    // ---------- i18n ----------
    function fillLangSelects() {
        const entries = TL_LANGS.map(c => [c, tlLangLabel(c, currentLang)]);
        fillSelect($("tl-src"), [["auto", i18nText("p_auto_lang", currentLang)]].concat(entries), S.sourceLang);
        fillSelect($("tl-tgt"), entries, S.targetLang);
    }
    function fillUiLang() {
        fillSelect($("ui-lang"), [["auto", "🌐 " + i18nText("ui_auto", currentLang)]].concat(TL_LANGS.map(c => [c, TL_LANG_NAMES[c]])), uiPref);
        $("ui-lang").title = i18nText("ui_lang_label", currentLang);
    }
    function fillProviders() { fillSelect($("tl-provider"), providerEntries(currentLang), S.provider); }
    function applyI18n(lang) {
        document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = i18nText(el.dataset.i18n, lang); });
        document.documentElement.lang = lang;
        document.documentElement.dir = UI_RTL.includes(lang) ? "rtl" : "ltr";
        $("tl-list").title = i18nText("o_list", lang);
        fillUiLang();
        fillLangSelects();
        fillProviders();
    }

    // ---------- messaging ----------
    function broadcastMessage(msg) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, msg).catch(() => {});
        });
    }
    const ERR_KEY = { E101: "err_tab", E102: "err_reach", E103: "err_video", E105: "err_unexpected" };
    function showError(code, detail) {
        const el = $("error-banner");
        el.textContent = `${i18nText("err_label", currentLang)} ${code} · ${i18nText(ERR_KEY[code] || "err_unexpected", currentLang)}${detail ? "\n" + detail : ""}`;
        el.style.whiteSpace = "pre-wrap"; el.style.display = "block";
    }
    function sendAndConfirm(msg) {
        $("error-banner").style.display = "none";
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs && tabs[0];
            if (!tab || tab.id === undefined) return showError("E101");
            let attempt = 0;
            const tryOnce = () => {
                attempt++;
                Promise.resolve(chrome.tabs.sendMessage(tab.id, msg)).then((res) => {
                    if (res && res.ok) return window.close();
                    if (attempt < 4) setTimeout(tryOnce, 400); else showError("E103");
                }).catch((err) => {
                    const m = String((err && err.message) || err);
                    if (attempt < 4) return setTimeout(tryOnce, 400);
                    showError(/Receiving end does not exist|Could not establish connection/i.test(m) ? "E102" : "E105", m.slice(0, 120));
                });
            };
            tryOnce();
        });
    }
    const styleChange = (patch) => { chrome.storage.local.set(patch); broadcastMessage({ type: "STYLE_UPDATE", patch }); };
    const saveTl = () => chrome.storage.local.set({ tl: S });
    function tlStatus(msg, cls) { $("tl-status").className = "status " + (cls || ""); $("tl-status").textContent = msg; }

    // ---------- tabs / language ----------
    document.querySelectorAll(".tab-btn").forEach(btn => btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
        btn.classList.add("active");
        $("tab-" + btn.dataset.tab).classList.add("active");
    }));
    $("ui-lang").addEventListener("change", (e) => {
        uiPref = e.target.value;
        currentLang = resolveUiLang(uiPref);
        chrome.storage.local.set({ uiLang: uiPref });
        applyI18n(currentLang);
        broadcastMessage({ type: "SET_LANG", lang: uiPref });
    });

    // ---------- Translate tab ----------
    function renderTl() {
        const llm = S.provider !== "google";
        const cfg = S[S.provider] || {};
        $("tl-provider").value = S.provider;
        $("tl-llm").style.display = llm ? "block" : "none";
        $("tl-model-wrap").style.display = cfg.model !== undefined ? "block" : "none";     // DeepL has no model
        $("tl-base-wrap").style.display = S.provider === "custom" ? "block" : "none";      // only the custom/local engine needs a URL here
        if (llm) { $("tl-key").value = cfg.apiKey || ""; $("tl-model").value = cfg.model || ""; $("tl-base").value = cfg.baseUrl || ""; }
        $("tl-hide").checked = !!S.hideOriginal;
        $("tl-auto").checked = !!S.autoStart;
    }
    $("tl-provider").addEventListener("change", (e) => { S.provider = e.target.value; renderTl(); tlStatus(""); saveTl(); });
    $("tl-key").addEventListener("change", (e) => { if (S[S.provider]) { S[S.provider].apiKey = e.target.value.trim(); saveTl(); } });
    $("tl-model").addEventListener("change", (e) => { if (S[S.provider]) { S[S.provider].model = e.target.value.trim(); saveTl(); } });
    $("tl-base").addEventListener("change", (e) => { if (S.custom) { S.custom.baseUrl = e.target.value.trim(); saveTl(); } });
    $("tl-src").addEventListener("change", (e) => { S.sourceLang = e.target.value; saveTl(); });
    $("tl-tgt").addEventListener("change", (e) => { S.targetLang = e.target.value; saveTl(); });
    $("tl-hide").addEventListener("change", (e) => { S.hideOriginal = e.target.checked; saveTl(); });
    $("tl-auto").addEventListener("change", (e) => { S.autoStart = e.target.checked; saveTl(); });
    $("dual-toggle").addEventListener("change", (e) => {
        chrome.storage.local.set({ dualEnabled: e.target.checked });
        broadcastMessage({ type: "TOGGLE_DUAL", dualEnabled: e.target.checked });
    });
    $("tl-list").addEventListener("click", async () => {
        await saveTl(); tlStatus("…");
        const r = await chrome.runtime.sendMessage({ type: "TL_LIST_MODELS" });
        if (!r.ok) return tlStatus(r.error, "bad");
        fillDatalist($("tl-models"), r.models);
        tlStatus(i18nText("p_models_found", currentLang, { n: r.models.length }));
    });
    $("tl-test").addEventListener("click", async () => {
        await saveTl(); tlStatus("…");
        const r = await chrome.runtime.sendMessage({ type: "TL_TEST" });
        tlStatus(r.ok ? `OK · ${r.ms} ms\n${r.out.join("\n")}` : r.error, r.ok ? "ok" : "bad");
    });
    $("tl-more").addEventListener("click", () => { chrome.runtime.openOptionsPage(); window.close(); });
    $("tl-start").addEventListener("click", () => sendAndConfirm({ type: "TL_TOGGLE" }));

    // ---------- Style / Original tabs ----------
    const sliders = [
        ["size", "subSize", "%"], ["opacity", "subOpacity", "%"], ["edge", "edgeBottom", "%"], ["border-width", "borderWidth", "px"],
        ["size2", "subSize2", "%"], ["opacity2", "subOpacity2", "%"], ["border-width2", "borderWidth2", "px"], ["dual-gap", "dualGap", "px"]
    ];
    sliders.forEach(([id, key, unit]) => $(id + "-slider").addEventListener("input", (e) => {
        $(id + "-value").textContent = e.target.value + unit;
        styleChange({ [key]: Number(e.target.value) });
    }));
    [["color-picker","subColor"],["border-color-picker","borderColor"],["color2-picker","subColor2"],["border-color2-picker","borderColor2"],
     ["shadow-select","shadowLevel"],["font-select","subFont"],["shadow2-select","shadowLevel2"],["font2-select","subFont2"]]
        .forEach(([id, key]) => $(id).addEventListener("input", (e) => styleChange({ [key]: e.target.value })));
    $("ratio-select").addEventListener("change", (e) => {
        chrome.storage.local.set({ aspectMode: e.target.value });
        broadcastMessage({ type: "TOGGLE_RATIO", aspectMode: e.target.value });
    });
    $("drag-mode-toggle").addEventListener("change", (e) => {
        chrome.storage.local.set({ dragMode: e.target.checked });
        broadcastMessage({ type: "TOGGLE_DRAG_MODE", dragMode: e.target.checked });
    });
    $("position-top-toggle").addEventListener("change", (e) => styleChange({ positionTop: e.target.checked }));

    // ---------- Site tab ----------
    const hostOf = (tab) => { try { return new URL(tab.url).hostname.replace(/^www\./, ""); } catch (e) { return null; } };
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { $("current-host").textContent = (tabs[0] && hostOf(tabs[0])) || "-"; });
    $("save-site-profile").addEventListener("click", () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const host = tabs[0] && hostOf(tabs[0]); if (!host) return;
            chrome.storage.local.get(SITE_KEYS.concat("siteProfiles"), (d) => {
                const profile = {}; SITE_KEYS.forEach(k => { if (d[k] !== undefined) profile[k] = d[k]; });
                const siteProfiles = d.siteProfiles || {}; siteProfiles[host] = profile;
                chrome.storage.local.set({ siteProfiles });
            });
        });
    });
    $("reset-site-profile").addEventListener("click", () => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const host = tabs[0] && hostOf(tabs[0]); if (!host) return;
            chrome.storage.local.get(["siteProfiles"], (d) => {
                const siteProfiles = d.siteProfiles || {}; delete siteProfiles[host];
                chrome.storage.local.set({ siteProfiles });
            });
        });
    });
    $("reset-all-settings").addEventListener("click", () => {
        if (confirm(i18nText("reset_all_confirm", currentLang))) chrome.storage.local.remove(STYLE_KEYS.concat("dualEnabled"), () => window.close());
    });

    chrome.storage.onChanged.addListener(async (ch, area) => {
        if (area !== "local" || !ch.tl) return;
        S = await tlGetSettings(); renderTl(); fillLangSelects(); fillProviders();
    });

    // ---------- initial state ----------
    chrome.storage.local.get(STYLE_KEYS.concat(["uiLang", "dualEnabled"]), (d) => {
        uiPref = d.uiLang || "auto";
        currentLang = resolveUiLang(uiPref);
        applyI18n(currentLang);
        renderTl();
        sliders.forEach(([id, key, unit]) => { if (d[key] !== undefined) { $(id + "-slider").value = d[key]; $(id + "-value").textContent = d[key] + unit; } });
        [["color-picker","subColor"],["border-color-picker","borderColor"],["color2-picker","subColor2"],["border-color2-picker","borderColor2"],
         ["shadow-select","shadowLevel"],["font-select","subFont"],["shadow2-select","shadowLevel2"],["font2-select","subFont2"],["ratio-select","aspectMode"]]
            .forEach(([id, key]) => { if (d[key] !== undefined) $(id).value = d[key]; });
        $("drag-mode-toggle").checked = !!d.dragMode;
        $("position-top-toggle").checked = !!d.positionTop;
        $("dual-toggle").checked = d.dualEnabled !== false;
    });
});
