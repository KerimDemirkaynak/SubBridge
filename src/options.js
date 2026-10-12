
const $ = (id) => document.getElementById(id);
let S = null, uiPref = "auto", uiLang = "en";
let shown = null;   // engine whose values are currently in the key/model/base-url inputs
const T = (k, v) => i18nText(k, uiLang, v);

function fillLangs() {
  const entries = TL_LANGS.map(c => [c, tlLangLabel(c, uiLang)]);
  fillSelect($("sourceLang"), [["auto", T("p_auto_lang")]].concat(entries), S.sourceLang);
  fillSelect($("targetLang"), entries, S.targetLang);
}
function applyI18n() {
  document.documentElement.lang = uiLang;
  document.documentElement.dir = UI_RTL.includes(uiLang) ? "rtl" : "ltr";
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = T(el.dataset.i18n); });
  fillSelect($("uiLang"), [["auto", "🌐 " + T("ui_auto")]].concat(TL_LANGS.map(c => [c, TL_LANG_NAMES[c]])), uiPref);
  fillSelect($("provider"), providerEntries(uiLang), S.provider);
  fillLangs();
}
function showEndpoint() {
  const b = normBase($("baseUrl").value);
  $("endpoint").textContent = b ? "POST " + b + (S.provider === "anthropic" ? "/messages" : "/chat/completions") : "";
}

function render() {
  $("provider").value = S.provider;
  shown = S.provider;
  const llm = S.provider !== "google";
  const c = S[S.provider] || {};
  $("p-google").classList.toggle("on", !llm);
  $("p-llm").classList.toggle("on", llm);
  if (llm) {
    $("apiKey").value = c.apiKey || "";
    $("modelWrap").style.display = c.model !== undefined ? "block" : "none";     // DeepL has no model
    $("model").value = c.model || "";
    $("baseWrap").style.display = c.baseUrl !== undefined ? "block" : "none";
    $("baseUrl").value = c.baseUrl || "";
    showEndpoint();
  }
  ["batchSize", "concurrency", "ctxLines", "glossary"].forEach(k => { $(k).value = S[k]; });
  $("hideOriginal").checked = !!S.hideOriginal; $("autoStart").checked = !!S.autoStart;
}
function collect() {
  const prev = shown || S.provider;                 // write the inputs back to the engine they were showing...
  if (prev !== "google" && S[prev]) {
    const c = S[prev];
    c.apiKey = $("apiKey").value.trim();
    if (c.model !== undefined) c.model = $("model").value.trim();
    if (c.baseUrl !== undefined) c.baseUrl = $("baseUrl").value.trim() || c.baseUrl;
  }
  S.provider = $("provider").value;                 // ...and only then switch engine
  S.sourceLang = $("sourceLang").value || S.sourceLang; S.targetLang = $("targetLang").value || S.targetLang;
  S.hideOriginal = $("hideOriginal").checked; S.autoStart = $("autoStart").checked;
  S.batchSize = +$("batchSize").value || 40; S.concurrency = +$("concurrency").value || 2; S.ctxLines = +$("ctxLines").value || 0;
  S.glossary = $("glossary").value;
}
const save = () => chrome.storage.local.set({ tl: S, uiLang: uiPref });
function status(msg, cls) { $("status").className = cls || ""; $("status").textContent = msg; }

// custom base URLs need a runtime host permission
async function ensureHost(url) {
  try {
    const o = new URL(url).origin + "/*";
    if (await chrome.permissions.contains({ origins: [o] })) return true;
    return await chrome.permissions.request({ origins: [o] });
  } catch (e) { return false; }
}
async function guardedCall(type) {
  collect(); await save();
  const cfg = S[S.provider];
  if (cfg && cfg.baseUrl && !(await ensureHost(cfg.baseUrl))) {
    status("Host permission was not granted for " + cfg.baseUrl, "bad"); return null;
  }
  return chrome.runtime.sendMessage({ type });
}

(async () => {
  const { uiLang: ul } = await chrome.storage.local.get("uiLang");
  S = await tlGetSettings();
  uiPref = ul || "auto"; uiLang = resolveUiLang(uiPref);
  applyI18n(); render();

  document.querySelectorAll("input,select,textarea").forEach(el => el.addEventListener("change", () => {
    if (el.id === "provider") { collect(); render(); }
    else if (el.id === "uiLang") { uiPref = el.value; uiLang = resolveUiLang(uiPref); collect(); applyI18n(); }
    else collect();
    save();
  }));

  // the popup writes the same settings: pick up its changes instead of overwriting them later
  chrome.storage.onChanged.addListener(async (ch, area) => {
    if (area !== "local" || !ch.tl) return;
    S = await tlGetSettings(); applyI18n(); render();
  });

  $("baseUrl").addEventListener("input", showEndpoint);
  $("list").onclick = async () => {
    status("...");
    const r = await guardedCall("TL_LIST_MODELS");
    if (!r) return;
    if (!r.ok) return status(r.error, "bad");
    fillDatalist($("models"), r.models);
    status(T("p_models_found", { n: r.models.length }), "ok");
  };
  $("test").onclick = async () => {
    status("...");
    const r = await guardedCall("TL_TEST");
    if (!r) return;
    status(r.ok ? `OK (${r.ms} ms)\n${r.out.join("\n")}` : r.error, r.ok ? "ok" : "bad");
  };
  $("clear").onclick = async () => { await chrome.runtime.sendMessage({ type: "TL_CLEAR_CACHE" }); status("OK", "ok"); };
})();
