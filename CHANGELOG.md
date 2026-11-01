# Changelog

## 3.1.0

- Add Crunchyroll playback metadata discovery, replay, cross-frame delivery and HTTPS subtitle downloads. Choose source locales explicitly or automatically, and combine same-language subtitle/sign and closed-caption tracks.
- Read ASS event column formats, ignore vector drawing commands, keep literal angle brackets, reject invalid timings and sort cues. Preserve VTT line breaks and ignore NOTE/STYLE/REGION blocks. Treat cue end timestamps as exclusive.
- Stop sending unsent full-file and live translation requests after Stop/navigation. Bound live requests, retain the latest pending line and use native cue timestamps.
- Restore native track modes once per track, keep YouTube CC available for live fallback and prevent duplicate popup retries from toggling translation twice.
- Avoid losing new episode captions to delayed navigation timers. Reject older Crunchyroll episode metadata and retain subtitle files captured after a navigation.
- Keep saved provider models and compatible endpoints intact, normalize custom URLs, validate batches and apply request timeouts and bounded retry delays. Report invalid/empty engine output as a failure.
- Separate translation cache entries by endpoint, glossary and context. Share concurrent cache initialization and prevent in-flight translations from repopulating a cleared cache.
- Fix document-start initialization on mobile, live site-profile removal/reset, iframe hostname detection, subtitle drag offsets and drag listener accumulation. Cache expensive outline shadows.
- Keep auto-start active for late-loaded players and new videos while respecting a manual Stop.
- Add automated parser, provider and integration regression tests plus Chrome/Firefox package validation and CI builds.

### Verification limits

Tests use local playback/ASS fixtures and mocked translation responses. Authenticated Crunchyroll playback, hardcoded model availability, live translation API quotas and store signing have not been verified by these tests. Burned-in video text cannot be hidden by the subtitle overlay. The generated Firefox XPI is unsigned.
