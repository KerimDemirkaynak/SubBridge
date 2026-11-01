// =========================================================================
// SubBridge - content.js (subtitle renderer: styling, dual line, drag positioning)
// =========================================================================

const DEFAULTS = {
    isEnabled: true,
    aspectMode: "auto",      // 'auto' | '16:9' | '4:3' | 'vertical'
    subSize: 100,            // %
    subOpacity: 100,         // %
    subColor: "#ffffff",
    borderColor: "#000000",
    borderWidth: 2,          // px
    shadowLevel: "normal",   // 'none' | 'normal' | 'strong'
    subFont: "sans-serif",
    edgeBottom: 12,          // % - distance from bottom
    posOffsetX: 0,           // px - drag offset
    posOffsetY: 0,           // px
    dragMode: false,
    dualEnabled: true,
    subColor2: "#ffd400",
    subSize2: 80,
    subOpacity2: 100,        // % - secondary opacity
    subFont2: "",            // empty = inherit primary font
    borderColor2: "#000000",
    borderWidth2: 2,         // px
    shadowLevel2: "normal",  // 'none' | 'normal' | 'strong'
    dualGap: 8,              // px - extra gap between primary and secondary
    positionTop: false,
    siteProfiles: {},
    uiLang: "auto"
};

const SITE_PRESETS = {
    "youtube.com":      { subSize: 100, subColor: "#ffffff", subFont: "Roboto, sans-serif", edgeBottom: 10 },
    "netflix.com":      { subSize: 100, subColor: "#ffffff", subFont: "sans-serif", edgeBottom: 12 },
    "crunchyroll.com":  { subSize: 115, subColor: "#ffd400", subFont: "Arial, sans-serif", edgeBottom: 12 },
    "twitch.tv":        { subSize: 90,  subColor: "#ffffff", subFont: "sans-serif", edgeBottom: 14 },
    "vimeo.com":        { subSize: 100, subColor: "#ffffff", subFont: "sans-serif", edgeBottom: 12 }
};

let settings = JSON.parse(JSON.stringify(DEFAULTS));

let activeVideo = null;
let customSubContainer = null;   
let customSubContainer2 = null;  
let parsedSubtitles = [];
let parsedSubtitles2 = [];
let syncAnimationId = null;
let videoWatchTimer = null;
let lastPrimaryRenderedHeight = 0; // Cache last known primary height for stable secondary positioning

function tr(key, vars) { return i18nText(key, settings.uiLang, vars); }

function loadSettings(callback) {
    chrome.storage.local.get(Object.keys(DEFAULTS), (data) => {
        settings = Object.assign({}, DEFAULTS, data);
        settings._userTouchedStyle = Object.keys(data).some(k => ["subSize", "subColor", "subFont", "edgeBottom"].includes(k));
        applySitePreset();
        if (callback) callback();
    });
}

function applySitePreset() {
    const host = location.hostname.replace(/^www\./, "");
    const presetKey = Object.keys(SITE_PRESETS).find(k => host === k || host.endsWith("." + k));
    const userOverride = settings.siteProfiles && settings.siteProfiles[host];
    if (userOverride) {
        Object.assign(settings, userOverride);
    } else if (presetKey && !settings._userTouchedStyle) {
        Object.assign(settings, SITE_PRESETS[presetKey]);
    }
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    // Recompose from global settings each time, so deleting a site profile also removes its overrides.
    if (Object.keys(changes).some(key => key in DEFAULTS)) loadSettings(() => { updateSubStyle(); updateSubStyle2(); });
});

loadSettings();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.type) {
        case "TOGGLE_EXTENSION":
            settings.isEnabled = request.isEnabled;
            break;
        case "TOGGLE_RATIO":
            settings.aspectMode = request.aspectMode;
            updateSubStyle();
            break;
        case "CHANGE_SIZE":
            settings.subSize = request.size;
            updateSubStyle();
            break;
        case "STYLE_UPDATE":
            Object.assign(settings, request.patch);
            settings._userTouchedStyle = true;
            updateSubStyle();
            updateSubStyle2();
            break;
        case "TOGGLE_DRAG_MODE":
            settings.dragMode = request.dragMode;
            updateSubStyle();
            break;
        case "TOGGLE_DUAL":
            settings.dualEnabled = request.dualEnabled;
            if (!settings.dualEnabled && customSubContainer2) customSubContainer2.style.display = "none";
            break;
        case "SET_LANG":
            settings.uiLang = request.lang || "auto";
            chrome.storage.local.set({ uiLang: settings.uiLang });
            break;
        case "GET_STATE":
            if (!getActiveVideo()) return; // let the video-owning iframe answer the popup
            sendResponse({
                hasVideo: true,
                primaryLoaded: parsedSubtitles.length > 0,
                secondaryLoaded: parsedSubtitles2.length > 0,
                hostname: location.hostname.replace(/^www\./, "")
            });
            break;
    }
});

function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement ||
           document.mozFullScreenElement || document.msFullscreenElement || null;
}

function ensureContainerParent(container) {
    if (!container) return;
    const fsEl = getFullscreenElement();
    const desiredParent = fsEl || document.body;
    if (container.parentNode !== desiredParent) {
        try { desiredParent.appendChild(container); } catch (e) { /* ignore */ }
    }
}

["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"].forEach(evt => {
    document.addEventListener(evt, () => {
        ensureContainerParent(customSubContainer);
        ensureContainerParent(customSubContainer2);
        const toast = document.getElementById("sb-toast");
        if (toast) ensureContainerParent(toast);
        updateSubStyle();
        updateSubStyle2();
    });
});

// ---- Toast: only show in the frame that actually owns the video ----
function isMainVideoFrame() {
    return !!document.querySelector("video");
}

function showToast(msg) {
    // Guard: skip frames that have no video (avoids duplicates in sub-frames)
    if (!isMainVideoFrame()) return;

    let toast = document.getElementById("sb-toast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "sb-toast";
        toast.style.cssText = `
            position: fixed;
            background: rgba(79, 70, 229, 0.95);
            color: white;
            padding: 10px 20px;
            border-radius: 6px;
            font-family: 'Segoe UI', sans-serif;
            font-size: 13px;
            font-weight: bold;
            z-index: 2147483647;
            opacity: 0;
            transition: opacity 0.3s, transform 0.3s;
            pointer-events: none;
            box-shadow: 0 4px 15px rgba(0,0,0,0.5);
            border: 1px solid #388e3c;
            text-align: center;
        `;
        document.body.appendChild(toast);
    }
    
    ensureContainerParent(toast);
    toast.innerText = msg;
    
    if (activeVideo) {
        const rect = getVideoContentRect(activeVideo);
        const centerX = rect.left + rect.width / 2;
        const topY = rect.top + rect.height * 0.15;
        toast.style.left = `${centerX}px`;
        toast.style.top = `${topY}px`;
        toast.style.bottom = "auto";
        toast.style.transform = "translate(-50%, -50%)";
    } else {
        toast.style.left = "50%";
        toast.style.top = "auto";
        toast.style.bottom = "80px";
        toast.style.transform = "translateX(-50%)";
    }

    toast.style.opacity = "1";
    if (toast.hideTimeout) clearTimeout(toast.hideTimeout);
    toast.hideTimeout = setTimeout(() => { toast.style.opacity = "0"; }, 2500);
}

// Convert supported ASS override tags to HTML, strip unsupported ones
function convertASSFormattingToHTML(text) {
    // ASS vector drawings are shapes, not subtitle text. Drawing mode can end within a line.
    let drawing = false;
    text = text.split(/(\{[^}]*\})/g).map(part => {
        if (part.startsWith("{")) {
            for (const m of part.matchAll(/\\p(\d+)\b/g)) drawing = +m[1] > 0;
            if (/\\r(?:[^\\}]*)/.test(part)) drawing = false;
            return part;
        }
        return drawing ? "" : part.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }).join("");
    let result = text.replace(/\{([^}]*)\}/g, (_match, content) => {
        let html = "";

        // Bold: \b1 = on, \b0 = off (but not \b100 etc. which are font weights)
        if (/\\b1(?!\d)/.test(content)) html += "<b>";
        if (/\\b0(?!\d)/.test(content)) html += "</b>";

        // Italic: \i1 = on, \i0 = off
        if (/\\i1(?!\d)/.test(content)) html += "<i>";
        if (/\\i0(?!\d)/.test(content)) html += "</i>";

        // Underline: \u1 = on, \u0 = off
        if (/\\u1(?!\d)/.test(content)) html += "<u>";
        if (/\\u0(?!\d)/.test(content)) html += "</u>";

        // Strikethrough: \s1 = on, \s0 = off
        if (/\\s1(?!\d)/.test(content)) html += "<s>";
        if (/\\s0(?!\d)/.test(content)) html += "</s>";

        // Color: \c&H[AA]BBGGRR& or \1c&H[AA]BBGGRR& (ASS uses BGR order)
        const colorMatch = content.match(/\\1?c\s*&H([0-9A-Fa-f]+)&/);
        if (colorMatch) {
            const hex = colorMatch[1];
            if (hex.length >= 6) {
                // Take last 6 chars as BBGGRR (skip optional alpha prefix)
                const tail = hex.slice(-6);
                const r = tail.substring(4, 6), g = tail.substring(2, 4), b = tail.substring(0, 2);
                html += `<font color="#${r}${g}${b}">`;
            }
        }

        return html;
    });

    // Hard line breaks stay on separate lines; soft breaks and hard spaces become spaces.
    result = result.replace(/\\N/g, "\n").replace(/\\[nh]/g, " ");

    return result.trim();
}

function parseASS(assText) {
    const lines = assText.split("\n");
    let subs = [];
    let resX = 384, resY = 288; // ASS spec defaults
    let foundResX = false, foundResY = false;
    const styles = Object.create(null); // style names come from an untrusted subtitle
    let styleFormatFields = [];  // column order from Style Format line
    let eventFields = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
    let currentSection = "";
    const tToS = (t) => {
        const p = t.trim().split(":");
        return p.length !== 3 ? NaN : (Number(p[0]) * 3600) + (Number(p[1]) * 60) + Number(p[2]);
    };
    // Map legacy SSA \a values to ASS \an values
    const ssaToAn = { 1:1, 2:2, 3:3, 5:7, 6:8, 7:9, 9:4, 10:5, 11:6 };

    lines.forEach(line => {
        const trimmed = line.trim();

        // Track which section we're in
        if (trimmed.startsWith("[")) {
            currentSection = trimmed.toLowerCase();
            return;
        }

        // [Script Info] - PlayResX / PlayResY
        const resXMatch = trimmed.match(/^PlayResX\s*:\s*(\d+)/i);
        if (resXMatch) { resX = parseInt(resXMatch[1], 10); foundResX = true; return; }
        const resYMatch = trimmed.match(/^PlayResY\s*:\s*(\d+)/i);
        if (resYMatch) { resY = parseInt(resYMatch[1], 10); foundResY = true; return; }

        // [V4+ Styles] or [V4 Styles] - parse Format and Style lines
        if (currentSection.includes("styles")) {
            if (/^Format:/i.test(trimmed)) {
                styleFormatFields = trimmed.substring(7).split(",").map(s => s.trim().toLowerCase());
                return;
            }
            if (/^Style:/i.test(trimmed)) {
                const values = trimmed.substring(6).split(",").map(s => s.trim());
                const nameIdx = styleFormatFields.indexOf("name");
                const alignIdx = styleFormatFields.indexOf("alignment");
                const fsIdx = styleFormatFields.indexOf("fontsize");
                const isLegacySSA = currentSection.includes("v4 styles") && !currentSection.includes("v4+");
                if (nameIdx >= 0 && nameIdx < values.length) {
                    let styleAlign = (alignIdx >= 0 && alignIdx < values.length)
                        ? parseInt(values[alignIdx], 10) || 2
                        : 2;
                    if (isLegacySSA) styleAlign = ssaToAn[styleAlign] || 2;
                    styles[values[nameIdx]] = {
                        alignment: styleAlign,
                        fontSize: (fsIdx >= 0 && fsIdx < values.length)
                            ? (parseFloat(values[fsIdx]) || null)
                            : null
                    };
                }
                return;
            }
        }

        // Dialogue lines
        if (currentSection === "[events]" && /^Format:/i.test(trimmed)) {
            eventFields = trimmed.slice(7).split(",").map(s => s.trim().toLowerCase());
        }
        if (currentSection === "[events]" && /^Dialogue:/i.test(trimmed)) {
            const parts = trimmed.slice(trimmed.indexOf(":") + 1).split(",");
            const textIdx = eventFields.indexOf("text");
            const field = key => parts[eventFields.indexOf(key)] || "";
            if (textIdx === eventFields.length - 1 && parts.length >= eventFields.length) {
                let text = parts.slice(textIdx).join(",");
                const start = tToS(field("start")), end = tToS(field("end"));
                if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return;
                // Extract \pos(x,y) before stripping override tags
                let pos = null;
                const posMatch = text.match(/\\pos\s*\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/);
                if (posMatch) {
                    pos = { x: parseFloat(posMatch[1]), y: parseFloat(posMatch[2]) };
                }
                // Extract alignment override: \an (ASS) or \a (SSA legacy)
                let alignment = null;
                const anMatch = text.match(/\\an\s*(\d+)/);
                if (anMatch) {
                    alignment = parseInt(anMatch[1], 10);
                } else {
                    const aMatch = text.match(/\\a\s*(\d+)/);
                    if (aMatch) {
                        alignment = ssaToAn[parseInt(aMatch[1], 10)] || 2;
                    }
                }
                const styleName = field("style").trim();
                // Fall back to style's alignment, then default (2 = bottom-center)
                if (alignment === null) {
                    alignment = (styles[styleName] && styles[styleName].alignment) || 2;
                }
                // Font size in PlayRes units: \fs override first, else the style's Fontsize.
                // (\fs followed directly by digits, so \fscx / \fsp are not matched)
                let fontSize = null;
                const fsMatch = text.match(/\\fs(\d+(?:\.\d+)?)/);
                if (fsMatch) fontSize = parseFloat(fsMatch[1]);
                else if (styles[styleName] && styles[styleName].fontSize) fontSize = styles[styleName].fontSize;

                // Convert supported ASS formatting to HTML, strip unsupported tags
                text = convertASSFormattingToHTML(text);
                if (text) subs.push({ start, end, text, pos, alignment, fontSize });
            }
        }
    });
    // Only one PlayRes given: derive the other one the way libass does (4:3)
    if (foundResX && !foundResY) resY = Math.round(resX * 3 / 4);
    else if (foundResY && !foundResX) resX = Math.round(resY * 4 / 3);
    // Guard against 0 / nonsense values so we never divide by zero later
    if (!(resX > 0)) resX = 384;
    if (!(resY > 0)) resY = 288;
    subs.sort((a, b) => a.start - b.start || a.end - b.end);
    return { subs, resX, resY };
}

// Style one overlay entry (positioned / non-default alignment) like a real ASS renderer:
//  - font size = ASS font size (PlayRes units) scaled by video height / PlayResY
//    (still multiplied by the user's size slider)
//  - \pos is the anchor point of the text box according to the alignment (\an),
//    not always its bottom-centre; the box is also limited so it can't leave the video
// Convert ASS \an alignment (numpad layout) to CSS absolute positioning
// 7=TL  8=TC  9=TR
// 4=ML  5=MC  6=MR
// 1=BL  2=BC  3=BR
window.addEventListener("keydown", (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (document.activeElement && document.activeElement.isContentEditable)) return;
    if (!e.altKey) return;

    switch (e.code) {
        case "KeyE":       settings.isEnabled = !settings.isEnabled; chrome.storage.local.set({ isEnabled: settings.isEnabled }); e.preventDefault(); break;
        case "KeyD":       settings.dualEnabled = !settings.dualEnabled; chrome.storage.local.set({ dualEnabled: settings.dualEnabled }); e.preventDefault(); break;
        case "KeyP":       settings.dragMode = !settings.dragMode; updateSubStyle(); e.preventDefault(); break;
        case "KeyT":       settings.positionTop = !settings.positionTop; chrome.storage.local.set({ positionTop: settings.positionTop }); updateSubStyle(); e.preventDefault(); break;
    }
});

// Visible part of a <video> in pixels (0 = hidden, collapsed, off-screen, display:none, transparent).
// Sites like YouTube keep hidden/preview <video> elements around; those must never count as "the" video.
function videoVisibleArea(v) {
    const r = v.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return 0;
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const w = Math.min(r.right, vw) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    if (w <= 0 || h <= 0) return 0;
    const cs = getComputedStyle(v);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return 0;
    return w * h;
}

function getActiveVideo() {
    let best = null, bestScore = 0;
    for (const v of document.querySelectorAll("video")) {
        const area = videoVisibleArea(v);
        if (!area) continue;
        const score = area * (v.paused ? 1 : 1.5);   // a playing video beats a paused one of similar size
        if (score > bestScore) { bestScore = score; best = v; }
    }
    return best;
}

function currentPageKey() {
    const u = new URL(location.href);
    if (/(^|\.)youtube(-nocookie)?\.com$/i.test(u.hostname)) return u.origin + u.pathname + "?v=" + (u.searchParams.get("v") || "");
    if (/(^|\.)crunchyroll\.com$/i.test(u.hostname)) return u.origin + u.pathname;
    return u.href;
}
let lastPageUrl = currentPageKey();

function watchForVideoChanges() {
    if (videoWatchTimer) clearInterval(videoWatchTimer);
    videoWatchTimer = setInterval(() => {
        const v = getActiveVideo();
        const currentUrl = currentPageKey();

        // SPA Navigation Fix: If URL changes (e.g. clicked a new YouTube video), clear subtitles
        // if the user doesn't want them auto-restored. This is much safer than checking video.src.
        if (currentUrl !== lastPageUrl) {
            lastPageUrl = currentUrl;
            parsedSubtitles = [];
            parsedSubtitles2 = [];
            if (customSubContainer) { customSubContainer.textContent = ""; customSubContainer.style.display = "none"; }
            if (customSubContainer2) { customSubContainer2.textContent = ""; customSubContainer2.style.display = "none"; }
        }

        if (v && v !== activeVideo) {
            activeVideo = v;
            
            if (parsedSubtitles.length > 0) initContainer(v);
            if (parsedSubtitles2.length > 0) initContainer2(v);
            
            ensureSyncLoop(v);
        } else if (!v && activeVideo) {
            activeVideo = null;
            if (customSubContainer) customSubContainer.style.display = "none";
            if (customSubContainer2) customSubContainer2.style.display = "none";
        }
    }, 800);
}
watchForVideoChanges();


function initContainer(videoElement) {
    activeVideo = videoElement;
    if (customSubContainer) customSubContainer.remove();
    customSubContainer = document.createElement("div");
    ensureContainerParent(customSubContainer);
    enableDragHandlers(customSubContainer, "primary");
    updateSubStyle();
}

function initContainer2(videoElement) {
    activeVideo = videoElement;
    if (customSubContainer2) customSubContainer2.remove();
    customSubContainer2 = document.createElement("div");
    ensureContainerParent(customSubContainer2);
    updateSubStyle2();
}

// The old 4/8 integer-offset shadows left visible stair-steps (mobile AND desktop).
// Use a round ring of sub-pixel offsets with a tiny blur so the outline is
// anti-aliased. The number of directions grows with the outline width so wide
// outlines don't get scalloped edges; a second inner ring keeps thin glyph
// strokes from detaching from their outline.
function buildSmoothShadow(color, w, strong) {
    const ring = (radius, steps, blur) => {
        const out = [];
        for (let i = 0; i < steps; i++) {
            const a = (Math.PI * 2 * i) / steps;
            const x = (Math.cos(a) * radius).toFixed(2);
            const y = (Math.sin(a) * radius).toFixed(2);
            out.push(`${x}px ${y}px ${blur}px ${color}`);
        }
        return out;
    };
    // Radius/blur calibrated (by rendering old vs new) so the outline weight matches the
    // old 4/8-offset look: a plain ring at radius w looked ~10-25% thinner.
    const r = strong ? w * 1.2 : w;
    const blur = 0.8;
    const outerSteps = Math.min(32, Math.max(strong ? 16 : 12, Math.ceil(Math.PI * 2 * w)));
    const parts = ring(r, outerSteps, blur);
    if (strong || w >= 3) parts.push(...ring(r * 0.5, Math.max(8, Math.ceil(outerSteps / 2)), blur));
    if (strong) parts.push(`0px 0px ${w}px ${color}`);
    return parts.join(", ");
}

const shadowCache = new Map();
function buildTextShadow(borderColor, borderWidth, shadowLevel) {
    if (shadowLevel === "none") return "none";
    const w = Math.max(1, borderWidth);
    const key = `${borderColor}|${w}|${shadowLevel}`;
    if (!shadowCache.has(key)) {
        if (shadowCache.size >= 32) shadowCache.delete(shadowCache.keys().next().value);
        shadowCache.set(key, buildSmoothShadow(borderColor, w, shadowLevel === "strong"));
    }
    return shadowCache.get(key);
}

// ---- Safe subtitle renderer (handles <i>, <b>, <u>, <s>, <font color>, \n) --------
// Uses DOMParser so we never call innerHTML with untrusted content directly.
const SAFE_INLINE_TAGS = new Set(["i", "b", "u", "s", "em", "strong", "br", "font"]);
function setSubText(container, text) {
    container.textContent = ""; // clear safely
    container.setAttribute("dir", "auto");   // Arabic / Hebrew / Persian / Urdu read right-to-left
    if (!text) return;

    // Convert plain newlines to <br> so DOMParser sees them as breaks
    const html = text.replace(/\n/g, "<br>");

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    function importSafe(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            return document.createTextNode(node.textContent);
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName.toLowerCase();
            if (SAFE_INLINE_TAGS.has(tag)) {
                const el = document.createElement(tag);
                // Only allow the 'color' attribute on <font>
                if (tag === "font" && node.getAttribute("color")) {
                    el.setAttribute("color", node.getAttribute("color"));
                }
                node.childNodes.forEach(child => {
                    const safe = importSafe(child);
                    if (safe) el.appendChild(safe);
                });
                return el;
            } else {
                // Unknown/unsafe tag: keep its text children, drop the tag itself
                const frag = document.createDocumentFragment();
                node.childNodes.forEach(child => {
                    const safe = importSafe(child);
                    if (safe) frag.appendChild(safe);
                });
                return frag;
            }
        }
        return null;
    }

    doc.body.childNodes.forEach(child => {
        const safe = importSafe(child);
        if (safe) container.appendChild(safe);
    });
}


// ---- Mobile Detection & Font Support -------------------------------------
const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

if (isMobile) {
    // Inject Google Fonts on mobile so that font selections actually render differently 
    // (since Android/iOS lack fonts like Arial, Tahoma, etc. by default).
    const fontLink = document.createElement("link");
    fontLink.rel = "stylesheet";
    fontLink.href = "https://fonts.googleapis.com/css2?family=Roboto:wght@700&family=Open+Sans:wght@700&family=Noto+Sans:wght@700&display=swap";
    const appendFont = () => { if (document.head) document.head.appendChild(fontLink); };
    if (document.head) appendFont();
    else document.addEventListener("DOMContentLoaded", appendFont, { once: true });
}

// Returns the rectangle the video PICTURE actually occupies on screen.
// <video>.getBoundingClientRect() is the element box, which is the whole player area:
// with object-fit: contain (the default) a 16:9 video on a 20:9 phone screen or in a
// 4:3 box is letterboxed/pillarboxed INSIDE that box. Subtitles must be laid out against
// the picture (videoWidth x videoHeight aspect), not against the black bars.
function getVideoContentRect(video) {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || r.width <= 0 || r.height <= 0) return r;

    const cs = getComputedStyle(video);
    const fit = cs.objectFit || "fill";
    if (fit === "fill" || fit === "cover") return r; // fill = stretched, cover = cropped to box

    // Content box = element box minus border and padding
    const pl = parseFloat(cs.paddingLeft) || 0, pr = parseFloat(cs.paddingRight) || 0;
    const pt = parseFloat(cs.paddingTop) || 0,  pb = parseFloat(cs.paddingBottom) || 0;
    const bl = parseFloat(cs.borderLeftWidth) || 0, br = parseFloat(cs.borderRightWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0,  bb = parseFloat(cs.borderBottomWidth) || 0;
    const boxL = r.left + bl + pl, boxT = r.top + bt + pt;
    const boxW = r.width - bl - br - pl - pr, boxH = r.height - bt - bb - pt - pb;
    if (boxW <= 0 || boxH <= 0) return r;

    let scale = Math.min(boxW / vw, boxH / vh);          // contain
    if (fit === "none") scale = 1;
    else if (fit === "scale-down") scale = Math.min(1, scale);
    const w = vw * scale, h = vh * scale;

    // object-position (computed value is "<x> <y>", percentages or lengths)
    const pos = (cs.objectPosition || "50% 50%").split(/\s+/);
    const off = (token, free) => {
        if (!token) return free / 2;
        if (token.endsWith("%")) return free * (parseFloat(token) / 100);
        const px = parseFloat(token);
        return isNaN(px) ? free / 2 : px;
    };
    const left = boxL + off(pos[0], boxW - w);
    const top  = boxT + off(pos[1], boxH - h);
    return { left, top, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top };
}

function computeBoxRect() {
    if (!activeVideo) return null;
    const rect = getVideoContentRect(activeVideo);
    if (rect.width === 0 || rect.height === 0) return null;
    const isVertical = settings.aspectMode === "vertical" ||
        (settings.aspectMode === "auto" && rect.height > rect.width * 1.1);
    const maxWidthRatio = isVertical ? 0.92 : (settings.aspectMode === "4:3" ? 0.65 : 0.9);
    return { rect, isVertical, maxWidthRatio };
}

function updateSubStyle() {
    if (!customSubContainer) return;
    const info = computeBoxRect();
    if (!info) { customSubContainer.style.display = "none"; return; }
    const { rect, maxWidthRatio } = info;

    // Font size is based on the video picture width (not the viewport), so it is identical on any screen
    const fontSize = `calc(clamp(14px, ${rect.width * 0.032}px, 58px) * ${settings.subSize / 100})`;
    
    const centerX = rect.left + rect.width / 2 + settings.posOffsetX;

    let positionCss = "";
    if (settings.positionTop) {
        const topPx = rect.top + rect.height * (settings.edgeBottom / 100) - settings.posOffsetY;
        positionCss = `top: ${topPx}px;`;
    } else {
        const bottomPx = rect.top + rect.height * (1 - settings.edgeBottom / 100) - settings.posOffsetY;
        positionCss = `bottom: ${window.innerHeight - bottomPx}px;`;
    }

    applyCss(customSubContainer, `
        position: fixed; left: ${centerX}px; ${positionCss}
        transform: translateX(-50%); width: ${rect.width * maxWidthRatio}px; text-align: center;
        pointer-events: ${settings.dragMode ? "auto" : "none"}; z-index: 2147483646;
        font-family: ${settings.subFont}; font-size: ${fontSize}; font-weight: bold;
        color: ${settings.subColor}; opacity: ${settings.subOpacity / 100};
        text-shadow: ${buildTextShadow(settings.borderColor, settings.borderWidth, settings.shadowLevel)};
        display: ${customSubContainer.__shown ? "block" : "none"}; white-space: pre-wrap; line-height: 1.25;
        ${settings.dragMode ? "outline: 1px dashed #22d3ee; cursor: grab; border-radius:4px;" : ""}
    `);
}

function updateSubStyle2() {
    if (!customSubContainer2) return;
    const info = computeBoxRect();
    if (!info) { customSubContainer2.style.display = "none"; return; }
    const { rect, maxWidthRatio } = info;

    // Font: use secondary-specific font if set, otherwise fall back to primary font
    const font2 = (settings.subFont2 && settings.subFont2 !== "") ? settings.subFont2 : settings.subFont;
    
    // Font size based on the video picture width (not the viewport)
    const fontSize2 = `calc(clamp(14px, ${rect.width * 0.032}px, 58px) * ${settings.subSize2 / 100})`;
        
    const centerX = rect.left + rect.width / 2 + settings.posOffsetX;

    // Use the REAL rendered height of the primary container when available.
    // This correctly handles multi-line primary subtitles.
    let primaryActualHeight;
    if (customSubContainer && customSubContainer.style.display !== "none") {
        const primaryBR = customSubContainer.getBoundingClientRect();
        if (primaryBR.height > 0) {
            lastPrimaryRenderedHeight = primaryBR.height;
            primaryActualHeight = primaryBR.height;
        }
    }
    // Fallback: use the cached last-known height so secondary doesn't jump
    // when the primary disappears between subtitle cues.
    if (!primaryActualHeight) {
        if (lastPrimaryRenderedHeight > 0) {
            primaryActualHeight = lastPrimaryRenderedHeight;
        } else {
            const primaryFontRefPx = Math.min(58, Math.max(14, rect.width * 0.032)) * (settings.subSize / 100);
            primaryActualHeight = primaryFontRefPx * 1.35;
        }
    }

    const gap = (settings.dualGap !== undefined ? settings.dualGap : 8);

    let positionCss2 = "";
    if (settings.positionTop) {
        const primaryTopPx = rect.top + rect.height * (settings.edgeBottom / 100) - settings.posOffsetY;
        const secondaryTopPx = primaryTopPx + primaryActualHeight + gap;
        positionCss2 = `top: ${secondaryTopPx}px;`;
    } else {
        const primaryBottomPx = rect.top + rect.height * (1 - settings.edgeBottom / 100) - settings.posOffsetY;
        const secondaryBottomPx = primaryBottomPx - primaryActualHeight - gap;
        positionCss2 = `bottom: ${window.innerHeight - secondaryBottomPx}px;`;
    }

    applyCss(customSubContainer2, `
        position: fixed; left: ${centerX}px; ${positionCss2}
        transform: translateX(-50%); width: ${rect.width * maxWidthRatio}px; text-align: center;
        pointer-events: none; z-index: 2147483645;
        font-family: ${font2}; font-size: ${fontSize2}; font-weight: bold;
        color: ${settings.subColor2}; opacity: ${(settings.subOpacity2 !== undefined ? settings.subOpacity2 : 100) / 100};
        text-shadow: ${buildTextShadow(settings.borderColor2 || "#000000", settings.borderWidth2 !== undefined ? settings.borderWidth2 : 2, settings.shadowLevel2 || "normal")};
        display: ${(settings.dualEnabled && customSubContainer2.__shown) ? "block" : "none"};
        white-space: pre-wrap; line-height: 1.25;
    `);
}

function enableDragHandlers(container, target) {
    let dragging = false, startX = 0, startY = 0, baseX = 0, baseY = 0;
    container.addEventListener("mousedown", (e) => {
        if (!settings.dragMode) return;
        dragging = true;
        startX = e.clientX; startY = e.clientY;
        baseX = settings.posOffsetX; baseY = settings.posOffsetY;
        e.preventDefault();
    });
    const move = (e) => {
        if (!dragging) return;
        settings.posOffsetX = baseX + (e.clientX - startX);
        settings.posOffsetY = -(e.clientY - startY) + baseY;
        updateSubStyle();
        updateSubStyle2();
    };
    const up = () => {
        if (!dragging) return;
        dragging = false;
        chrome.storage.local.set({ posOffsetX: settings.posOffsetX, posOffsetY: settings.posOffsetY });
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
    };
    container.addEventListener("mousedown", () => {
        if (!dragging) return;
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
    });
}

// Text of every cue active at time t (cues may overlap), joined by newlines.
function activeText(cues, t) {
    let out = "", n = 0;
    for (let i = 0; i < cues.length; i++) {
        const c = cues[i];
        if (t >= c.start && t < c.end) out += (n++ ? "\n" : "") + c.text;
    }
    return out;
}

// Only touch the DOM when the text really changed (re-parsing it 60x per second made lines flicker).
function showText(container, text) {
    if (container.__shown === text && (text === "" || container.hasChildNodes())) return;
    setSubText(container, text);
    container.__shown = text;
}

// Apply a style string only if it changed (or something else edited the inline style).
function applyCss(el, css) {
    if (el.__css === css && el.style.cssText === el.__applied) return;
    el.style.cssText = css;
    el.__css = css;
    el.__applied = el.style.cssText;
}

function ensureSyncLoop(videoElement) {
    activeVideo = videoElement;
    if (syncAnimationId) cancelAnimationFrame(syncAnimationId);

    function checkTime() {
        if (!activeVideo || !document.body.contains(activeVideo)) {
            const v = getActiveVideo();
            activeVideo = v;
            if (!v) {
                if (customSubContainer) customSubContainer.style.display = "none";
                if (customSubContainer2) customSubContainer2.style.display = "none";
            }
        }
        if (activeVideo) {
            ensureContainerParent(customSubContainer);
            ensureContainerParent(customSubContainer2);

            let text1 = "", text2 = "";
            if (settings.isEnabled) {
                const t = activeVideo.currentTime;
                if (parsedSubtitles.length) text1 = activeText(parsedSubtitles, t);
                if (settings.dualEnabled && parsedSubtitles2.length) text2 = activeText(parsedSubtitles2, t);
            }

            // 1) CONTENT first ...
            if (customSubContainer) showText(customSubContainer, text1);
            if (customSubContainer2) showText(customSubContainer2, text2);
            // 2) ... then LAYOUT, primary before secondary: the secondary line is stacked on top of the
            //    primary one and must measure the primary's CURRENT height (1 line vs 2 lines), not last frame's.
            updateSubStyle();
            updateSubStyle2();
        }
        syncAnimationId = requestAnimationFrame(checkTime);
    }
    checkTime();
}

