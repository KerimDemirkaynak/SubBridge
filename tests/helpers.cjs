const { JSDOM } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = name => fs.readFileSync(path.join(root, 'src', name), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function storage(initial = {}) {
  const data = structuredClone(initial), changes = [];
  return {
    data,
    onChanged: { addListener: fn => changes.push(fn) },
    local: {
      get(keys, callback) {
        const out = Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, structuredClone(data[k])]));
        if (callback) { queueMicrotask(() => callback(out)); return; }
        return Promise.resolve(out);
      },
      async set(patch) {
        const delta = {};
        for (const [key, value] of Object.entries(patch)) {
          if (JSON.stringify(data[key]) === JSON.stringify(value)) continue;
          delta[key] = { oldValue: data[key], newValue: structuredClone(value) };
          data[key] = structuredClone(value);
        }
        if (Object.keys(delta).length) changes.forEach(fn => fn(delta, 'local'));
      },
      async remove(keys) {
        const delta = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (key in data) { delta[key] = { oldValue: data[key] }; delete data[key]; }
        }
        if (Object.keys(delta).length) changes.forEach(fn => fn(delta, 'local'));
      }
    }
  };
}
function page(url = 'https://example.com/watch', initial = {}, send = async () => ({}), mobile = false) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><video></video></body></html>', { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, listeners = [];
  if (mobile) Object.defineProperty(w.navigator, 'userAgent', { value: 'Android Mobile' });
  w.chrome = {
    storage: storage(initial), i18n: { getUILanguage: () => 'tr-TR' },
    runtime: { onMessage: { addListener: fn => listeners.push(fn) }, sendMessage: send }
  };
  const video = w.document.querySelector('video');
  video.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360 });
  Object.defineProperty(video, 'videoWidth', { value: 1920 });
  Object.defineProperty(video, 'videoHeight', { value: 1080 });
  const run = name => vm.runInContext(source(name), dom.getInternalVMContext(), { filename: name });
  const emit = data => w.dispatchEvent(new w.MessageEvent('message', { data, source: w }));
  const message = req => { let res; listeners.forEach(fn => fn(req, {}, value => { res = value; })); return res; };
  return { dom, w, video, run, emit, message, close: () => w.close() };
}
function provider(initial = {}) {
  const chrome = { storage: storage(initial), i18n: { getUILanguage: () => 'tr-TR' } };
  const context = vm.createContext({ chrome, URL, AbortSignal, setTimeout, clearTimeout, fetch, console, Intl });
  vm.runInContext(source('scripts.js') + '\n' + source('providers.js'), context);
  const run = code => vm.runInContext(code, context);
  return { context, chrome, run };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() > end) throw new Error('Timed out waiting for condition'); await new Promise(r => setTimeout(r, 10)); }
}
module.exports = { page, provider, source, plain, storage, tick, until, root };
