import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createFakeClis } from '../test-support/fake-clis.js';
import { gatherSetupState } from '../src/setup-state.js';

const TOOLKIT_ROOT = fileURLToPath(new URL('../', import.meta.url));

async function world(t, fakeOptions) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'setup-state-mods-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), repo = path.join(base, 'Proyecto'), bin = path.join(base, 'bin');
  await fs.mkdir(home);
  await fs.mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
  const clis = createFakeClis(home, fakeOptions);
  clis.installBin(bin);
  return { clis, options: { start: repo, homeDirectory: home, environment: { PATH: bin, HOME: home }, toolkitRoot: TOOLKIT_ROOT, runCommand: clis.runCommand } };
}

test('the state carries the mods of Claude Code, all missing by default', async (t) => {
  const w = await world(t);
  const state = await gatherSetupState(w.options);
  assert.deepEqual(state.mods, {
    niveles: 'falta', 'nexakit-modelo': 'falta', 'nexakit-ahorro': 'falta', 'nexakit-lecciones': 'falta', 'nexakit-sesion': 'falta',
    'nexakit-guardarrailes': 'falta',
  });
});

test('the state tells installed, outdated and disabled mods apart', async (t) => {
  const w = await world(t, { mods: { niveles: 'activo', 'nexakit-modelo': 'actualizable', 'nexakit-ahorro': 'desactivado' } });
  const state = await gatherSetupState(w.options);
  assert.equal(state.mods.niveles, 'activo');
  assert.equal(state.mods['nexakit-modelo'], 'actualizable');
  assert.equal(state.mods['nexakit-ahorro'], 'desactivado');
});

test('without Claude Code there is no mods state', async (t) => {
  const w = await world(t, { installed: ['codex'] });
  assert.equal((await gatherSetupState(w.options)).mods, null);
});
