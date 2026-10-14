// =========================================================================
// scripts.js - which writing system a language uses, and how much of a text is written in it.
// Shared by the background (is the translation in the requested language?) and the content script
// (which subtitle file is in the language the user wants?).
// =========================================================================
const SCRIPT_RX = {
    Latin: /\p{Script=Latin}/u, Cyrillic: /\p{Script=Cyrillic}/u, Arabic: /\p{Script=Arabic}/u, Hebrew: /\p{Script=Hebrew}/u,
    Greek: /\p{Script=Greek}/u, Thai: /\p{Script=Thai}/u, Devanagari: /\p{Script=Devanagari}/u, Bengali: /\p{Script=Bengali}/u,
    Tamil: /\p{Script=Tamil}/u, Telugu: /\p{Script=Telugu}/u,
    Han: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u, Hangul: /[\p{Script=Hangul}\p{Script=Han}]/u
};
const LANG_SCRIPT = {
    en: "Latin", tr: "Latin", es: "Latin", fr: "Latin", pt: "Latin", id: "Latin", de: "Latin", it: "Latin", pl: "Latin", nl: "Latin",
    ro: "Latin", cs: "Latin", sv: "Latin", hu: "Latin", ms: "Latin", tl: "Latin", sw: "Latin", vi: "Latin", hr: "Latin", da: "Latin",
    fi: "Latin", no: "Latin", ru: "Cyrillic", uk: "Cyrillic", bg: "Cyrillic", sr: "Cyrillic", ar: "Arabic", fa: "Arabic", ur: "Arabic",
    he: "Hebrew", el: "Greek", th: "Thai", hi: "Devanagari", bn: "Bengali", ta: "Tamil", te: "Telugu",
    "zh-CN": "Han", "zh-TW": "Han", ja: "Han", ko: "Hangul"
};
// Share (0..1) of the letters that belong to the expected script. 1 when there is too little text to judge.
function scriptShare(texts, lang) {
    const rx = SCRIPT_RX[LANG_SCRIPT[lang]];
    if (!rx) return 1;
    let total = 0, ok = 0;
    for (const ch of texts.join(" ")) {
        if (!/\p{L}/u.test(ch)) continue;
        total++;
        if (rx.test(ch)) ok++;
    }
    return total < 4 ? 1 : ok / total;
}
