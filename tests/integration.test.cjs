const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { page, plain, source, until, storage, tick } = require('./helpers.cjs');
const settings = { provider: 'google', sourceLang: 'auto', targetLang: 'tr', batchSize: 5, concurrency: 2, ctxLines: 3, hideOriginal: true, autoStart: false };
function grabber(t, url, send, initial = {}, publicSettings = settings) {
  const p = page(url, initial, async req => {
    if (req.type === 'TL_GET_SETTINGS') return { ok: true, settings: publicSettings };
    if (req.type === 'TL_CR_GET_TRACKS') return {};
    return send(req);
  });
  t.after(p.close);
  p.w.postMessage = data => {
    if (data.__tlAsk === 'selected') queueMicrotask(() => p.emit({ __tlSelected: 1, id: data.id, labels: [] }));
  };
  for (const name of ['i18n-content.js', 'content.js', 'scripts.js', 'parsers.js', 'crunchyroll.js', 'grabber.js']) p.run(name);
  return p;
}
const vtt = count => 'WEBVTT\n\n' + Array.from({ length: count }, (_, i) => `00:${String(Math.floor(i * 2 / 60)).padStart(2, '0')}:${String(i * 2 % 60).padStart(2, '0')}.000 --> 00:${String(Math.floor((i * 2 + 1) / 60)).padStart(2, '0')}:${String((i * 2 + 1) % 60).padStart(2, '0')}.000\nLine ${i}`).join('\n\n');
test('Stop prevents unsent batches and discards late translations; popup retry is idempotent', async t => {
  const pending = [];
  const p = grabber(t, 'https://example.com/watch', req => req.type === 'TL_TRANSLATE' ? new Promise(resolve => pending.push({ resolve, req })) : Promise.resolve({}));
  p.emit({ __tlHook: 1, url: 'https://example.com/subtitle.vtt', body: vtt(100) });
  assert.equal(p.message({ type: 'TL_TOGGLE', requestId: 'start' }).running, true);
  await until(() => pending.length === 2);
  assert.equal(p.message({ type: 'TL_TOGGLE', requestId: 'start' }).running, true);
  assert.equal(p.message({ type: 'TL_TOGGLE', requestId: 'stop' }).running, false);
  for (const { resolve, req } of pending) resolve({ ok: true, out: req.lines.map(() => 'Çeviri') });
  await tick(); await tick();
  assert.equal(pending.length, 2);
  assert.equal(p.w.eval('parsedSubtitles.length'), 0);
  assert.equal(p.w.document.getElementById('tl-hide-style'), null);
});
test('Crunchyroll metadata -> ASS downloads -> merged translated cues; wrong episode metadata is ignored', async t => {
  const downloads = [], translations = [];
  const fixtures = {
    'https://static.crunchyroll.com/en.ass': '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello',
    'https://static.crunchyroll.com/cc.ass': '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello\nDialogue: 0,0:00:02.00,0:00:04.00,Sign,,0,0,0,,Shop'
  };
  const p = grabber(t, 'https://www.crunchyroll.com/watch/G12345678/title', async req => {
    if (req.type === 'TL_FETCH_SUBTITLE') { downloads.push(req.url); return { ok: true, body: fixtures[req.url] }; }
    if (req.type === 'TL_TRANSLATE') { translations.push(req.lines); return { ok: true, out: req.lines.map(s => s === 'Hello' ? 'Merhaba' : 'Dükkân') }; }
    return {};
  });
  p.emit({ __tlTracks: 1, contentId: 'OLD', tracks: [{ lang: 'en-US', url: 'https://static.crunchyroll.com/old.ass' }] });
  p.emit({ __tlTracks: 1, contentId: 'G12345678', audioLocale: 'en-US', tracks: Object.keys(fixtures).map((url, i) => ({ url, lang: 'en-US', kind: i ? 'captions' : 'subtitles' })) });
  p.message({ type: 'TL_TOGGLE' });
  await until(() => p.w.eval('parsedSubtitles.length === 2 && parsedSubtitles[0].text === "Merhaba"'));
  assert.deepEqual(downloads, Object.keys(fixtures));
  assert.deepEqual(plain(translations), [['Hello', 'Shop']]);
  assert.equal(p.w.eval('parsedSubtitles2[0].text'), 'Hello');
  p.w.history.pushState({}, '', '/watch/G87654321/new-title');
  fixtures['https://static.crunchyroll.com/new.ass'] = fixtures['https://static.crunchyroll.com/en.ass'].replace('Hello', 'New');
  p.emit({ __tlTracks: 1, contentId: 'G87654321', audioLocale: 'ja-JP', tracks: [{ url: 'https://static.crunchyroll.com/new.ass', lang: 'en-US', kind: 'subtitles' }] });
  await until(() => p.w.eval('parsedSubtitles2.length === 1 && parsedSubtitles2[0].text === "New"'));
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(p.w.eval('parsedSubtitles2[0].text'), 'New', 'navigation timers must not erase the new episode');
});
test('native track modes are restored exactly once, including disabled tracks', async t => {
  const p = grabber(t, 'https://example.com/watch', async req => req.type === 'TL_TRANSLATE' ? { ok: true, out: ['Merhaba'] } : {});
  const track = { kind: 'subtitles', language: 'en', label: 'English', mode: 'disabled', cues: [{ startTime: 0, endTime: 2, text: 'Hello' }] };
  Object.defineProperty(p.video, 'textTracks', { value: [track] });
  p.message({ type: 'TL_TOGGLE' });
  await until(() => p.w.eval('parsedSubtitles[0]?.text === "Merhaba"'));
  assert.equal(track.mode, 'hidden');
  p.message({ type: 'TL_TOGGLE' });
  assert.equal(track.mode, 'disabled');
});
test('mobile content script loads before head exists; site profiles apply and reset live', async t => {
  const p = page('https://www.crunchyroll.com/watch/G12345678', { subSize: 130, siteProfiles: { 'crunchyroll.com': { subSize: 150 } } }, async () => ({}), true);
  t.after(p.close);
  p.w.document.head.remove();
  p.run('i18n-content.js');
  assert.doesNotThrow(() => p.run('content.js'));
  await tick();
  assert.equal(p.w.eval('settings.subSize'), 150);
  await p.w.chrome.storage.local.set({ siteProfiles: {} }); await tick();
  assert.equal(p.w.eval('settings.subSize'), 130);
  await p.w.chrome.storage.local.remove('subSize'); await tick();
  assert.equal(p.w.eval('settings.subSize'), 115);
});
test('Crunchyroll hook observes fetch and reused JSON XHR without modifying player responses', async t => {
  const p = page('https://www.crunchyroll.com/watch/G12345678'); t.after(p.close);
  const data = { subtitles: { 'en-US': { url: 'https://static.crunchyroll.com/en.ass', format: 'ass' } } };
  const url = 'https://cr-play-service.prd.crunchyrollsvc.com/playback/v3/G12345678/web/chrome/play';
  const messages = [];
  p.w.postMessage = data => messages.push(data);
  p.w.TextDecoder = TextDecoder;
  const response = new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  p.w.fetch = () => Promise.resolve(response);
  class XHR extends p.w.EventTarget { open(_method, url) { this.url = url; } send() {} }
  p.w.XMLHttpRequest = XHR;
  p.run('crunchyroll.js'); p.run('hook-main.js');
  assert.equal(await p.w.fetch(url), response);
  await until(() => messages.some(m => m.__tlTracks));
  assert.deepEqual(await response.json(), data);
  const xhr = new XHR(); xhr.responseType = 'json'; xhr.response = data;
  xhr.open('GET', url); xhr.send(); xhr.send();
  const before = messages.length;
  xhr.dispatchEvent(new p.w.Event('load'));
  assert.equal(messages.length, before + 1, 'reused XHR must not accumulate load listeners');
  p.emit({ __tlAsk: 'tracks' });
  assert.equal(messages.at(-1).__tlTracks, 1);
});
test('background subtitle relay rejects external hosts and exposes no API key through public settings', async () => {
  let listener, fetched = 0;
  const ctx = vm.createContext({ URL, AbortSignal, TextDecoder, Response, chrome: {
    storage: storage(), runtime: { onMessage: { addListener: fn => { listener = fn; } } },
    tabs: { sendMessage: async () => {}, onRemoved: { addListener() {} } }
  }, fetch: async () => { fetched++; return new Response('WEBVTT'); },
  tlGetSettings: async () => ({ ...settings, custom: { apiKey: 'secret' } }) });
  vm.runInContext(source('crunchyroll.js') + '\n' + source('background.js'), ctx);
  const sender = { url: 'https://static.crunchyroll.com/player', tab: { id: 1 } };
  const send = (req, from = sender) => new Promise(resolve => listener(req, from, resolve));
  assert.equal((await send({ type: 'TL_FETCH_SUBTITLE', url: 'https://example.com/x' })).ok, false);
  assert.equal((await send({ type: 'TL_FETCH_SUBTITLE', url: 'https://static.crunchyroll.com/x' }, { url: 'https://example.com', tab: { id: 2 } })).ok, false);
  assert.equal(fetched, 0);
  assert.equal((await send({ type: 'TL_FETCH_SUBTITLE', url: 'https://static.crunchyroll.com/x' })).body, 'WEBVTT');
  const result = await send({ type: 'TL_GET_SETTINGS' });
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('live captions keep native timing, bound requests, and do not send queued work after Stop', async t => {
  const jobs = [];
  const p = grabber(t, 'https://example.com/live', req => req.type === 'TL_TRANSLATE' ? new Promise(resolve => jobs.push({ resolve, req })) : Promise.resolve({}));
  const native = new p.w.EventTarget();
  Object.assign(native, { kind: 'captions', language: 'en-US', label: 'English', mode: 'showing', cues: [], activeCues: [] });
  Object.defineProperty(p.video, 'textTracks', { value: [native] });
  let listening = false;
  const add = native.addEventListener.bind(native);
  native.addEventListener = (event, fn) => { if (event === 'cuechange') listening = true; add(event, fn); };
  p.message({ type: 'TL_TOGGLE' });
  await until(() => listening, 5000);
  for (let i = 0; i < 4; i++) {
    p.video.currentTime = i;
    native.activeCues = [{ startTime: i, endTime: i + 0.8, text: `Live ${i}` }];
    native.dispatchEvent(new p.w.Event('cuechange'));
  }
  assert.equal(jobs.length, 2, 'slow providers must not get an unbounded live queue');
  assert.equal(p.w.eval('parsedSubtitles[3].end'), 3.8);
  native.activeCues = []; p.video.currentTime = 3.5;
  native.dispatchEvent(new p.w.Event('cuechange'));
  assert.equal(p.w.eval('parsedSubtitles[3].end'), 3.5, 'disappearing captions must stop immediately');
  p.message({ type: 'TL_TOGGLE' });
  jobs.forEach(j => j.resolve({ ok: true, out: ['Çeviri'] }));
  await tick(); await tick();
  assert.equal(jobs.length, 2);
  assert.equal(native.mode, 'showing');
});
test('auto-start handles late players and new videos without undoing a manual Stop', async t => {
  let translated = 0;
  const p = grabber(t, 'https://example.com/first', async req => {
    if (req.type === 'TL_TRANSLATE') { translated++; return { ok: true, out: req.lines.map(() => 'Çeviri') }; }
    return {};
  }, {}, { ...settings, autoStart: true });
  p.emit({ __tlHook: 1, url: 'https://example.com/first.vtt', body: vtt(1) });
  await until(() => translated === 1);
  p.message({ type: 'TL_TOGGLE' });
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(p.w.eval('parsedSubtitles.length'), 0);
  assert.equal(translated, 1);
  p.w.history.pushState({}, '', '/next');
  p.emit({ __tlHook: 1, url: 'https://example.com/next.vtt', body: vtt(1) });
  await until(() => translated === 2, 4000);
  assert.equal(p.w.eval('parsedSubtitles[0].text'), 'Çeviri');
});
