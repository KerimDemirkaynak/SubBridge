const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const file of fs.readdirSync(path.join(root, 'src')).filter(f => f.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, 'src', file)], { stdio: 'inherit' });
  if (result.status) process.exit(result.status);
}
for (const target of ['chrome', 'firefox']) {
  const dir = path.join(root, 'dist', target);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json')));
  const files = [...m.content_scripts.flatMap(s => s.js), ...(m.background.scripts || [m.background.service_worker]), m.action.default_popup, m.options_ui.page, ...Object.values(m.icons)];
  for (const file of files) if (!fs.existsSync(path.join(dir, file))) throw new Error(`${target}: missing ${file}`);
  if (m.content_scripts[0].js.indexOf('crunchyroll.js') > m.content_scripts[0].js.indexOf('grabber.js')) throw new Error('Bad content script order');
}
console.log('JavaScript syntax and both extension manifests passed');
