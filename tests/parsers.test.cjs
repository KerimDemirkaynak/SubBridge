const test = require('node:test');
const assert = require('node:assert/strict');
const { page, plain } = require('./helpers.cjs');
function parser(t) {
  const p = page(); t.after(p.close);
  for (const name of ['i18n-content.js', 'content.js', 'scripts.js', 'parsers.js']) p.run(name);
  return p.w;
}
test('VTT excludes comments and invalid ranges and retains line breaks/entities', t => {
  const w = parser(t);
  const result = w.parseAnyFile('WEBVTT\n\nNOTE example\n00:00.000 --> 00:01.000\nnot a cue\n\n00:03.00 --> 00:04.0\nLate<br>line\n\n00:01.12 --> 00:02.34\nTom &amp; Jerry\n\n00:04.0 --> 00:03.0\ninvalid');
  assert.deepEqual(plain(result), [{ start: 1.12, end: 2.34, text: 'Tom & Jerry' }, { start: 3, end: 4, text: 'Late\nline' }]);
});
test('ASS respects event Format, comma text, drawing mode, sorting and invalid times', t => {
  const w = parser(t);
  const body = '[Events]\nFormat: Layer, End, Start, Style, Text\nDialogue: 0,0:00:05.00,0:00:03.00,Default,Hello, world\\NNext\\hword\nDialogue: 0,0:00:03.00,0:00:01.00,Sign,{\\p1}m 0 0 l 10 10{\\p0}Shop\nDialogue: 0,0:00:02.00,0:00:02.00,Default,invalid\nDialogue: 0,nonsense,0:00:00.00,Default,invalid';
  assert.deepEqual(plain(w.parseAnyFile(body)), [{ start: 1, end: 3, text: 'Shop' }, { start: 3, end: 5, text: 'Hello, world\nNext word' }]);
});
test('YouTube rolling captions stop at the next event and malformed events are harmless', t => {
  const w = parser(t);
  const body = JSON.stringify({ events: [{ tStartMs: 1000, dDurationMs: 9000, segs: [{ utf8: 'First' }] }, { tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: 'Next' }] }, { segs: {} }] });
  assert.deepEqual(plain(w.parseAnyFile(body, 'https://youtube.com/api/timedtext?kind=asr')), [{ start: 1, end: 2, text: 'First' }, { start: 2, end: 5, text: 'Next' }]);
  assert.equal(w.parseJson3('{"events":{}}').length, 0);
});
test('track deduplication preserves equal text at different timestamps and explicit language wins', t => {
  const w = parser(t);
  const a = { url: 'a', lang: 'en-US', at: 1, cues: [{ start: 0, end: 1, text: 'Okay' }] };
  const b = { url: 'b', lang: 'es-ES', at: 2, cues: [{ start: 10, end: 11, text: 'Okay' }] };
  assert.equal(w.dedupeCandidates([a, b]).length, 2);
  assert.equal(w.chooseCandidate([a, { ...b, showing: true }], { sourceLang: 'en' }).pick.url, 'a');
  assert.equal(w.chooseCandidate([a], { sourceLang: 'tr' }).pick, null);
});
test('cue end is exclusive so adjacent lines never overlap', t => {
  const w = parser(t);
  assert.equal(w.activeText([{ start: 0, end: 1, text: 'First' }, { start: 1, end: 2, text: 'Second' }], 1), 'Second');
});
