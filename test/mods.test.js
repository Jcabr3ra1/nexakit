import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MODS, applyMod, inspectMods, parseModsState } from '../src/mods.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const versionOf = (name) =>
  JSON.parse(fs.readFileSync(path.join(root, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const list = (entries) => ok(JSON.stringify(entries));

test('MODS lists the five plugins in order with their short labels', () => {
  assert.deepEqual(
    MODS.map((mod) => mod.name),
    ['niveles', 'nexakit-modelo', 'nexakit-ahorro', 'nexakit-lecciones', 'nexakit-sesion'],
  );
  assert.ok(Object.isFrozen(MODS));
  assert.equal(MODS[0].label, 'Subagentes por nivel para delegar');
  assert.equal(MODS[4].label, 'Avisa cuándo abrir una sesión nueva');
  assert.equal(MODS[0].id, 'niveles@agent-toolkit');
});

test('parseModsState tells active, disabled, missing and updatable apart', () => {
  const states = parseModsState(
    list([
      { id: 'niveles@agent-toolkit', enabled: true, version: versionOf('niveles') },
      { id: 'nexakit-modelo@agent-toolkit', enabled: false, version: versionOf('nexakit-modelo') },
      { id: 'nexakit-ahorro@agent-toolkit', enabled: true, version: '0.0.1' },
      { id: 'otro@x', enabled: true },
    ]),
    root,
  );
  assert.deepEqual(states, {
    niveles: 'activo',
    'nexakit-modelo': 'desactivado',
    'nexakit-ahorro': 'actualizable',
    'nexakit-lecciones': 'falta',
    'nexakit-sesion': 'falta',
  });
});

test('parseModsState reads an unreadable list as unknown, never missing', () => {
  for (const result of [null, { status: 1, stdout: '', stderr: 'x' }, ok('no es json'), ok('{"a":1}')]) {
    const states = parseModsState(result, root);
    assert.ok(MODS.every((mod) => states[mod.name] === 'desconocido'));
  }
});

test('inspectMods returns null without Claude Code and reads the list with it', async () => {
  assert.equal(await inspectMods({ agentsFound: { claude: false }, runCommand: () => ok('[]'), toolkitRoot: root }), null);
  const calls = [];
  const states = await inspectMods({
    agentsFound: { claude: true },
    runCommand: (command, args) => (calls.push([command, ...args].join(' ')), ok('[]')),
    toolkitRoot: root,
  });
  assert.deepEqual(calls, ['claude plugin list --json']);
  assert.equal(states.niveles, 'falta');
  const broken = await inspectMods({
    agentsFound: { claude: true },
    runCommand: () => {
      throw new Error('boom');
    },
    toolkitRoot: root,
  });
  assert.equal(broken.niveles, 'desconocido');
});

test('applyMod installs, enables and updates by state, and ignores the rest', async () => {
  const calls = [];
  const runCommand = (command, args) => (calls.push(args.join(' ')), ok());
  assert.equal(await applyMod('niveles', 'falta', { runCommand }), true);
  assert.equal(await applyMod('niveles', 'desactivado', { runCommand }), true);
  assert.equal(await applyMod('niveles', 'actualizable', { runCommand }), true);
  assert.equal(await applyMod('niveles', 'activo', { runCommand }), false);
  assert.equal(await applyMod('niveles', 'desconocido', { runCommand }), false);
  assert.deepEqual(calls, [
    'plugin install niveles@agent-toolkit',
    'plugin enable niveles@agent-toolkit',
    'plugin update niveles@agent-toolkit',
  ]);
});

test('applyMod adds the marketplace when it is missing and retries once', async () => {
  const calls = [];
  let installs = 0;
  const runCommand = (command, args) => {
    calls.push(args.join(' '));
    if (args[1] === 'install')
      return ++installs === 1 ? { status: 1, stdout: '', stderr: 'Plugin not found in marketplace agent-toolkit' } : ok();
    return ok();
  };
  assert.equal(await applyMod('nexakit-sesion', 'falta', { runCommand }), true);
  assert.deepEqual(calls, [
    'plugin install nexakit-sesion@agent-toolkit',
    'plugin marketplace add Jcabr3ra1/nexakit',
    'plugin install nexakit-sesion@agent-toolkit',
  ]);
});

test('applyMod falls back to a marketplace update, and throws with the detail on failure', async () => {
  const calls = [];
  const runCommand = (command, args) => {
    calls.push(args.join(' '));
    if (args[1] === 'install') return { status: 1, stdout: '', stderr: 'marketplace agent-toolkit not found' };
    if (args[2] === 'add') return { status: 1, stdout: '', stderr: 'ya existe' };
    return ok();
  };
  await assert.rejects(() => applyMod('niveles', 'falta', { runCommand }), /No se pudo instalar el mod niveles.*not found/u);
  assert.ok(calls.includes('plugin marketplace update agent-toolkit'));
  await assert.rejects(
    () => applyMod('niveles', 'desactivado', { runCommand: () => ({ status: 1, stdout: '', stderr: 'malo' }) }),
    /No se pudo activar el mod niveles. malo/u,
  );
});
