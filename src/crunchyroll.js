// Crunchyroll playback metadata helpers. Shared by the page hook, content script and background.
// This is an independent implementation; no SubTranslate source is bundled.
const SBCrunchyroll = (() => {
    const host = name => /(^|\.)crunchyroll\.com$/i.test(name);
    const apiHost = name => /(^|\.)(crunchyroll\.com|crunchyrollsvc\.com|vrv\.co)$/i.test(name);
    const locale = value => String(value || "").replace(/_/g, "-").toLowerCase();
    function watchId(url) {
        try { return (new URL(url).pathname.match(/\/watch\/([\w-]+)/i) || [])[1] || null; }
        catch (_) { return null; }
    }
    function playbackId(url) {
        try { return (new URL(url).pathname.match(/\/playback\/v\d+\/([^/]+)\//i) || [])[1] || null; }
        catch (_) { return null; }
    }
    function subtitleUrl(raw) {
        try {
            const u = new URL(raw);
            return u.protocol === "https:" && host(u.hostname) && !u.username && !u.password ? u.href : null;
        } catch (_) { return null; }
    }
    function extract(data, url) {
        const tracks = [], seen = new Set();
        let audioLocale = "";
        function walk(value, depth) {
            if (!value || typeof value !== "object" || depth > 8) return;
            if (typeof value.audioLocale === "string" || typeof value.audio_locale === "string") audioLocale = value.audioLocale || value.audio_locale;
            for (const [key, entries] of Object.entries(value)) {
                const k = key.toLowerCase().replace(/_/g, "");
                if (["subtitles", "captions", "closedcaptions"].includes(k) && entries && typeof entries === "object") {
                    for (const [code, item] of Object.entries(entries)) {
                        if (!item || typeof item !== "object") continue;
                        const link = subtitleUrl(item.url);
                        if (!link || seen.has(link) || tracks.length >= 100) continue;
                        seen.add(link);
                        tracks.push({ url: link, lang: String(item.language || item.locale || item.lang || code),
                            kind: k === "subtitles" ? "subtitles" : "captions", format: String(item.format || ""),
                            label: String(item.title || item.name || "") });
                    }
                } else if (entries && typeof entries === "object") walk(entries, depth + 1);
            }
        }
        walk(data, 0);
        return { contentId: playbackId(url), audioLocale, tracks };
    }
    // Respect an explicit source language; for dubs prefer closed captions in the audio language.
    // For Japanese audio without Japanese captions, English is the deterministic auto fallback.
    function select(tracks, sourceLang, audioLocale) {
        if (!tracks.length) return [];
        const want = locale(sourceLang), audio = locale(audioLocale);
        let pool = [];
        if (want && want !== "auto") {
            pool = tracks.filter(t => locale(t.lang) === want);
            if (!pool.length) pool = tracks.filter(t => locale(t.lang).split("-")[0] === want.split("-")[0]);
            if (!pool.length) return [];
        } else {
            pool = tracks.filter(t => locale(t.lang) === audio && t.kind === "captions");
            if (!pool.length) pool = tracks.filter(t => locale(t.lang) === "en-us");
            if (!pool.length) pool = tracks.filter(t => locale(t.lang).split("-")[0] === "en");
            if (!pool.length) pool = tracks;
        }
        const first = pool.find(t => t.kind === "captions" && locale(t.lang) === audio) || pool[0];
        return tracks.filter(t => locale(t.lang) === locale(first.lang));
    }
    function merge(groups) {
        const seen = new Set(), out = [];
        for (const cues of groups) for (const c of cues) {
            const key = JSON.stringify([c.start, c.end, c.text]);
            if (!seen.has(key)) { seen.add(key); out.push(c); }
        }
        return out.sort((a, b) => a.start - b.start || a.end - b.end);
    }
    return { host, apiHost, locale, watchId, playbackId, subtitleUrl, extract, select, merge };
})();
