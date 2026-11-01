import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { detectSignals } from '../src/project-signals.js';

// Builds a project tree: values are file contents, `{ link }` makes a symlink to another path in the tree.
async function tree(t, files) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-signals-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (content && typeof content === 'object' && 'link' in content) await fs.symlink(path.join(root, content.link), target);
    else await fs.writeFile(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

function snapshot(root) {
  const result = {};
  (function walk(dir) {
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isSymbolicLink()) result[path.relative(root, full)] = fsSync.readlinkSync(full);
      else result[path.relative(root, full)] = createHash('sha256').update(fsSync.readFileSync(full)).digest('hex') + fsSync.statSync(full).mtimeMs;
    }
  })(root);
  return result;
}

const ids = result => result.signals.map(signal => signal.id);

test('a README-only project gets its technologies from each README', async t => {
  const root = await tree(t, {
    'README.md': '# Taller\n\nBackend en Django y escritorio con Tauri.\n',
    'frontend/README.md': 'Interfaz en React con TypeScript que consume una API REST.\n'
  });
  const result = await detectSignals(root, { git: false });
  assert.deepEqual(ids(result), ['django', 'react', 'rest-api', 'tauri', 'typescript']);
  assert.deepEqual(result.signals.find(s => s.id === 'react').sources, ['frontend/README.md']);
  assert.deepEqual(result.signals.find(s => s.id === 'django').sources, ['README.md']);
  assert.equal(result.signals.find(s => s.id === 'rest-api').label, 'API REST');
  assert.deepEqual(result.scanned, ['.', 'frontend']);
  assert.deepEqual(result.limits, []);
});

test('a folder with a manifest is described by it, not by its README', async t => {
  const root = await tree(t, {
    'README.md': 'Proyecto con Django.\n',
    'backend/requirements.txt': '# deps\nDjango>=5.1\nfastapi[all]==0.115 ; python_version > "3.10"\nrequests\n',
    'backend/README.md': 'API con Django; el cliente usa React.\n',
    'tool/package.json': { name: 'tool' },
    'tool/README.md': 'Documenta React, Vue, Supabase y Playwright.\n'
  });
  const result = await detectSignals(root, { git: false });
  assert.deepEqual(ids(result), ['django', 'fastapi', 'nodejs', 'python']);
  assert.deepEqual(result.signals.find(s => s.id === 'django').sources, ['backend/requirements.txt (django)', 'README.md'], 'manifests first');
  assert.deepEqual(result.signals.find(s => s.id === 'fastapi').sources, ['backend/requirements.txt (fastapi)']);
  assert.deepEqual(result.signals.find(s => s.id === 'python').sources, ['backend/requirements.txt']);
});

test('an out-of-coverage manifest also stops its README from being read', async t => {
  const root = await tree(t, { 'svc/go.mod': 'module x\n', 'svc/README.md': 'Panel en React.\n' });
  assert.deepEqual(ids(await detectSignals(root, { git: false })), []);
});

test('Python, Rust and Tauri manifests give their signals', async t => {
  const root = await tree(t, {
    'backend/manage.py': 'import django\n',
    'api/pyproject.toml': '[project]\nname = "api"\n# django = "^5"\ndependencies = [\n  "flask>=3",\n]\n',
    'desktop/src-tauri/tauri.conf.json': '{}',
    'desktop/src-tauri/Cargo.toml': '[dependencies]\ntauri = { version = "2" }\n',
    'web/package.json': { name: 'web', dependencies: { '@tauri-apps/api': '2.0.0' } }
  });
  const result = await detectSignals(root, { git: false });
  assert.deepEqual(ids(result), ['django', 'flask', 'nodejs', 'python', 'rust', 'tauri']);
  assert.deepEqual(result.signals.find(s => s.id === 'django').sources, ['backend/manage.py']);
  assert.deepEqual(result.signals.find(s => s.id === 'tauri').sources,
    ['desktop/src-tauri/Cargo.toml (tauri)', 'desktop/src-tauri/tauri.conf.json', 'web/package.json (@tauri-apps/api)']);
  assert.deepEqual(result.signals.find(s => s.id === 'rust').sources, ['desktop/src-tauri/Cargo.toml']);
});

test('djangorestframework means Django and a REST API', async t => {
  const root = await tree(t, { 'requirements.txt': 'djangorestframework==3.15\n' });
  const result = await detectSignals(root, { git: false });
  assert.deepEqual(ids(result), ['django', 'python', 'rest-api']);
  assert.deepEqual(result.signals.find(s => s.id === 'rest-api').sources, ['requirements.txt (djangorestframework)']);
});

test('README words only count as whole words', async t => {
  const root = await tree(t, {
    'README.md': 'Un Reactor, Preact, Nextjs, vue-router, astronomía y la API RESTful. Mira flask_utils y pytauri.\n',
    'web/README.md': 'Servidor con Express.js.\n'
  });
  const result = await detectSignals(root, { git: false });
  assert.deepEqual(ids(result), ['express'], 'only Express.js counts');
});

test('ignored, hidden and dependency folders are not read, and only 20 subfolders are', async t => {
  const files = {
    '.gitignore': 'dist/\nvenv/\n',
    'dist/package.json': { name: 'built', dependencies: { react: '19.0.0' } },
    'venv/README.md': 'React',
    '.cache/README.md': 'Vue',
    'node_modules/x/README.md': 'Astro'
  };
  for (let i = 1; i <= 25; i++) files[`a${String(i).padStart(2, '0')}/README.md`] = 'Hecho con Svelte.';
  const root = await tree(t, files);
  execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
  const result = await detectSignals(root, { git: true });
  assert.equal(result.scanned.length, 21);
  assert.equal(result.scanned.at(-1), 'a20');
  assert.ok(!result.scanned.some(dir => ['dist', 'venv', '.cache', 'node_modules'].includes(dir)));
  assert.ok(result.limits.includes('Se revisaron 20 de 25 subcarpetas.'));
  assert.deepEqual(ids(result), ['svelte']);
});

test('without Git only the fixed rules apply', async t => {
  const root = await tree(t, { '.gitignore': 'dist/\n', 'dist/README.md': 'React', 'node_modules/README.md': 'Vue' });
  const result = await detectSignals(root, { git: false });
  assert.deepEqual(result.scanned, ['.', 'dist']);
  assert.deepEqual(ids(result), ['react']);
});

test('symlinked or oversized files are bounded and nothing is written', async t => {
  const root = await tree(t, {
    'notas.md': 'React',
    'README.md': { link: 'notas.md' },
    'frontend/README.md': 'x'.repeat(70 * 1024) + '\nDjango\n',
    'otro/package.json': { link: 'notas.md' }
  });
  const before = snapshot(root);
  const result = await detectSignals(root, { git: false });
  assert.deepEqual(result.signals, []);
  assert.ok(result.limits.includes('No se detectaron tecnologías en la raíz ni en sus subcarpetas.'));
  assert.deepEqual(snapshot(root), before);
});

test('existing manifest limits keep working, now per folder', async t => {
  const root = await tree(t, {
    'web/package.json': '{ broken json ',
    'web/next.config.mjs': 'export default {};',
    'svc/go.mod': 'module x\n'
  });
  const result = await detectSignals(root, { git: false });
  assert.ok(result.limits.some(l => /web\/package\.json/u.test(l)), result.limits.join('\n'));
  assert.ok(result.limits.some(l => /web\/next\.config\.mjs/u.test(l)));
  assert.ok(result.limits.some(l => /svc\/go\.mod/u.test(l)));
});
