const test = require('node:test');
const assert = require('node:assert/strict');
const { provider, plain, tick } = require('./helpers.cjs');
test('settings preserve deliberately selected compatible endpoints/models and clamp invalid sizes', async () => {
  const p = provider({ tl: { provider: 'custom', custom: { baseUrl: 'http://localhost:11434/v1/chat/completions/', model: 'local-model' }, openai: { baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek-chat' }, gemini: { model: 'gemini-2.5-flash' }, ctxLines: -3, concurrency: 99 } });
  const s = await p.run('tlGetSettings()');
  assert.equal(s.custom.baseUrl, 'http://localhost:11434/v1');
  assert.equal(s.openai.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(s.openai.model, 'deepseek-chat');
  assert.equal(s.gemini.model, 'gemini-2.5-flash');
  assert.equal(s.ctxLines, 0); assert.equal(s.concurrency, 8); assert.equal(s.targetLang, 'tr');
});
test('cache separates endpoint, glossary and context; zero context sends no history', async () => {
  const p = provider();
  const s = await p.run('tlGetSettings()'); s.provider = 'custom';
  p.context.settings = s;
  const key = () => p.run('cacheKey(settings, "Hello", ["Earlier"])');
  const a = key(); s.custom.baseUrl = 'http://localhost:1234/v1'; assert.notEqual(key(), a);
  const b = key(); s.glossary = 'Ben = Ben'; assert.notEqual(key(), b);
  const c = key(); s.ctxLines = 0; assert.notEqual(key(), c);
  assert.deepEqual(JSON.parse(p.run('llmPrompt(["Hello"], ["Earlier"], settings).user')).context_before, []);
});
test('concurrent cache loads share one map and clearing prevents old requests repopulating it', async t => {
  const p = provider(); t.after(() => p.run('cacheClear()'));
  const [a, b] = await Promise.all([p.run('cacheLoad()'), p.run('cacheLoad()')]); assert.equal(a, b);
  let resolve;
  p.context.rawTranslate = () => new Promise(r => { resolve = r; });
  const pending = p.run('tlTranslate(["Hello"], [])'); await tick();
  await p.run('cacheClear()'); resolve(['Merhaba']);
  assert.deepEqual(plain(await pending), ['Merhaba']);
  assert.equal((await p.run('cacheLoad()')).size, 0);
});
test('invalid or empty engine responses surface an error instead of reporting untranslated text as success', async () => {
  const p = provider(); p.context.rawTranslate = async () => null;
  await assert.rejects(p.run('tlTranslate(["Hello"], [])'), /incomplete or invalid/);
  await assert.rejects(p.run('tlTranslate("bad", [])'), /Invalid subtitle batch/);
  assert.equal(p.run('parseT(\'{"t":[{}]}\')'), null);
});
test('limiter handles synchronous throws and concurrency changes without creating independent queues', async () => {
  const p = provider(); let active = 0, max = 0; const release = [];
  p.context.job = () => new Promise(r => { active++; max = Math.max(max, active); release.push(() => { active--; r(); }); });
  const a = p.run('limiter(2)(job)'), b = p.run('limiter(2)(job)'); await tick();
  const c = p.run('limiter(1)(job)'); await tick(); assert.equal(max, 2);
  release.shift()(); await tick(); assert.equal(release.length, 1);
  release.shift()(); await tick(); release.shift()(); await Promise.all([a,b,c]);
  await assert.rejects(p.run('limiter(1)(() => { throw new Error("sync"); })'), /sync/);
});
test('last failed HTTP attempt does not wait for Retry-After', async () => {
  const p = provider(); let calls = 0, sleeps = 0;
  p.context.fetch = async () => { calls++; return { ok: false, status: 429, text: async () => 'quota', headers: new Headers({ 'retry-after': '999999' }) }; };
  p.context.setTimeout = () => { sleeps++; throw new Error('Unexpected sleep'); };
  await assert.rejects(p.run('fetchRetry("https://example.com", {}, 1)'), /HTTP 429/);
  assert.equal(calls, 1); assert.equal(sleeps, 0);
});
