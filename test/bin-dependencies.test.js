import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const moduleUrl = new URL('../src/missing-dependencies.js', import.meta.url);

// A copy of the sources with no node_modules, like a checkout where `npm ci` was never run.
async function bareCopy(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bin-deps-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const entry of ['bin', 'src', 'catalogs', 'package.json']) await fs.cp(path.join(ROOT, entry), path.join(root, entry), { recursive: true });
  return root;
}
const run = (root, bin, ...args) => spawnSync(process.execPath, [path.join(root, 'bin', bin), ...args], { encoding: 'utf8', cwd: root, env: { ...process.env, NODE_PATH: '' } });

test('both user commands explain how to install the dependencies of a checkout that lacks them', async t => {
  const root = await bareCopy(t);
  for (const bin of ['nexakit.js', 'agent-toolkit.js']) {
    const result = run(root, bin, '--help');
    assert.equal(result.status, 1, bin);
    assert.equal(result.stderr, `Faltan las dependencias de esta copia. Ejecuta \`npm ci\` en ${root}.\n`, bin);
    assert.equal(result.stdout, '', bin);
  }
});

test('with its dependencies installed the commands still work', () => {
  for (const bin of ['nexakit.js', 'agent-toolkit.js']) {
    const result = run(ROOT, bin, '--help');
    assert.equal(result.status, 0, bin);
    assert.match(result.stdout, /^Uso: npx nexakit/u, bin);
  }
});

test('only a missing package gets the explanation; any other failure is raised untouched', async () => {
  const { loadWithDependencyCheck } = await import(moduleUrl);
  const written = [];
  const options = { root: path.join(os.tmpdir(), 'una-copia'), write: text => written.push(text) };
  const failing = error => () => Promise.reject(error);
  const withCode = (code, message) => Object.assign(new Error(message), { code });
  const before = process.exitCode;
  try {
    // A missing file of our own sources is a bug, not a missing dependency.
    const ours = withCode('ERR_MODULE_NOT_FOUND', "Cannot find module '/x/src/otro.js' imported from /x/src/a.js");
    await assert.rejects(loadWithDependencyCheck(failing(ours), options), error => error === ours);
    const other = new Error('otro fallo');
    await assert.rejects(loadWithDependencyCheck(failing(other), options), error => error === other);
    // Running from an npx cache, `npm ci` would be the wrong advice.
    const missing = withCode('ERR_MODULE_NOT_FOUND', "Cannot find package 'ajv' imported from /x/src/a.js");
    await assert.rejects(loadWithDependencyCheck(failing(missing), { ...options, root: path.join(os.tmpdir(), '.npm/_npx/abc/node_modules/nexakit') }), error => error === missing);
    assert.deepEqual(written, []);

    process.exitCode = undefined;
    assert.equal(await loadWithDependencyCheck(failing(missing), options), null);
    assert.deepEqual([written, process.exitCode], [[`Faltan las dependencias de esta copia. Ejecuta \`npm ci\` en ${options.root}.\n`], 1]);

    const loaded = { ok: true };
    assert.equal(await loadWithDependencyCheck(() => Promise.resolve(loaded), options), loaded);
  } finally {
    process.exitCode = before;
  }
});
