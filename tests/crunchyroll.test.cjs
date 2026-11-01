const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { source, plain } = require('./helpers.cjs');
const ctx = vm.createContext({ URL });
vm.runInContext(source('crunchyroll.js') + '\nthis.CR = SBCrunchyroll;', ctx);
const CR = ctx.CR;
const tracks = [
  { lang: 'en-US', kind: 'subtitles', url: 'https://static.crunchyroll.com/en.ass' },
  { lang: 'es-ES', kind: 'subtitles', url: 'https://static.crunchyroll.com/es.ass' },
  { lang: 'en-US', kind: 'captions', url: 'https://static.crunchyroll.com/cc.ass' }
];
test('nested Crunchyroll playback maps and closed captions are detected', () => {
  const result = CR.extract({ data: { audio_locale: 'ja-JP', subtitles: { 'en-US': { url: tracks[0].url, format: 'ass' } }, closed_captions: [{ language: 'en-US', url: tracks[2].url }] } }, 'https://cr-play-service.prd.crunchyrollsvc.com/playback/v3/G12345678/web/chrome/play');
  assert.equal(result.contentId, 'G12345678');
  assert.equal(result.audioLocale, 'ja-JP');
  assert.deepEqual(plain(result.tracks.map(t => [t.lang, t.kind])), [['en-US', 'subtitles'], ['en-US', 'captions']]);
});
test('auto selects English for Japanese audio, and merges same-language captions/signs for dubs', () => {
  assert.deepEqual(plain(CR.select(tracks, 'auto', 'ja-JP').map(t => t.url)), [tracks[0].url, tracks[2].url]);
  assert.equal(CR.select(tracks, 'es', 'en-US')[0].lang, 'es-ES');
  assert.equal(CR.select(tracks, 'tr', 'ja-JP').length, 0);
});
test('subtitle fetch URLs reject unrelated hosts, credentials and non-HTTPS schemes', () => {
  for (const url of ['http://static.crunchyroll.com/x', 'https://evilcrunchyroll.com/a', 'https://crunchyroll.com.evil.test/a', 'https://user:pass@static.crunchyroll.com/x', 'file:///a']) assert.equal(CR.subtitleUrl(url), null);
  assert.ok(CR.subtitleUrl(tracks[0].url));
});
test('caption and subtitle merge removes duplicates and preserves overlapping dialogue', () => {
  const a = { start: 1, end: 3, text: 'Hello' }, b = { start: 2, end: 4, text: 'Shop' };
  assert.deepEqual(plain(CR.merge([[b, a], [a]])), [a, b]);
});
