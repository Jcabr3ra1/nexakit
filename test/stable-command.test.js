import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { acquireLock } from '../src/install-lock.js';
import { planStableCommand, writeStableCommand } from '../src/stable-command.js';

const TOOLKIT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const posix = { skip: process.platform === 'win32' ? 'the POSIX launcher is checked on macOS and Linux' : false };

async function home(t, name = 'home') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stable-command-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, name);
  await fs.mkdir(dir);
  return dir;
}
const options = (homeDirectory, extra = {}) => ({ homeDirectory, nodePath: process.execPath, toolkitRoot: TOOLKIT_ROOT, windows: false, ...extra });

test('writes a launcher that runs nexakit from the active root', posix, async t => {
  const h = await home(t);
  const plan = await planStableCommand(options(h));
  assert.equal(plan.state, 'falta');
  assert.equal(plan.path, path.join(h, '.nexakit', 'nexakit'));
  const lock = await acquireLock(path.join(h, '.nexakit'));
  try { await writeStableCommand(plan, lock); } finally { await lock.release(); }
  assert.equal((await fs.stat(plan.path)).mode & 0o777, 0o755);
  const run = spawnSync(plan.path, ['--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /npx nexakit/u);
  assert.equal((await planStableCommand(options(h))).state, 'igual');
});

test('the content changes when the active root changes, and Windows gets a .cmd', async t => {
  const h = await home(t);
  const plan = await planStableCommand(options(h));
  await fs.mkdir(path.dirname(plan.path), { recursive: true });
  await fs.writeFile(plan.path, plan.content);
  assert.equal((await planStableCommand(options(h, { toolkitRoot: '/otra/raiz' }))).state, 'distinto');
  const windows = await planStableCommand(options(h, { windows: true, nodePath: 'C:\\node\\node.exe', toolkitRoot: 'C:\\nx' }));
  assert.equal(windows.path, path.join(h, '.nexakit', 'nexakit.cmd'));
  assert.equal(windows.content, '@rem nexakit: orden estable (se reescribe sola)\r\n@"C:\\node\\node.exe" "C:\\nx\\bin\\nexakit.js" %*\r\n');
});

test('never replaces a link or a folder', async t => {
  const h = await home(t);
  const plan = await planStableCommand(options(h));
  await fs.mkdir(plan.path, { recursive: true });
  assert.equal((await planStableCommand(options(h))).state, 'conflicto');
  await fs.rm(plan.path, { recursive: true });
  await fs.symlink(path.join(h, 'other'), plan.path);
  const linked = await planStableCommand(options(h));
  assert.equal(linked.state, 'conflicto');
  const lock = await acquireLock(path.join(h, '.nexakit'));
  try { await writeStableCommand(linked, lock); } finally { await lock.release(); }
  assert.equal((await fs.lstat(plan.path)).isSymbolicLink(), true, 'left alone');
});

test('quotes paths with spaces and single quotes', posix, async t => {
  const h = await home(t, "Mi 'casa'");
  const root = path.join(h, "raíz con 'comillas'");
  await fs.cp(path.join(TOOLKIT_ROOT, 'bin'), path.join(root, 'bin'), { recursive: true });
  await fs.symlink(path.join(TOOLKIT_ROOT, 'src'), path.join(root, 'src'));
  await fs.symlink(path.join(TOOLKIT_ROOT, 'node_modules'), path.join(root, 'node_modules'));
  await fs.copyFile(path.join(TOOLKIT_ROOT, 'package.json'), path.join(root, 'package.json'));
  const plan = await planStableCommand(options(h, { toolkitRoot: root }));
  const lock = await acquireLock(path.join(h, '.nexakit'));
  try { await writeStableCommand(plan, lock); } finally { await lock.release(); }
  const run = spawnSync(plan.path, ['--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('stops if the lock is lost', async t => {
  const h = await home(t);
  const plan = await planStableCommand(options(h));
  const lost = { assertHeld: async () => { throw Object.assign(new Error('perdido'), { code: 'perdido' }); } };
  await assert.rejects(writeStableCommand(plan, lost), /perdido/u);
  await assert.rejects(fs.access(plan.path));
});

test('a file of the person at ~/.nexakit/nexakit is a conflict, and % is literal in the .cmd', async t => {
  const h = await home(t);
  const plan = await planStableCommand(options(h));
  await fs.mkdir(path.dirname(plan.path), { recursive: true });
  await fs.writeFile(plan.path, '#!/bin/sh\necho mío\n');
  const mine = await planStableCommand(options(h));
  assert.equal(mine.state, 'conflicto');
  const lock = await acquireLock(path.join(h, '.nexakit'));
  try { await writeStableCommand({ ...mine, state: 'distinto' }, lock); } finally { await lock.release(); }
  assert.equal(await fs.readFile(plan.path, 'utf8'), '#!/bin/sh\necho mío\n', 'not replaced even if asked to');
  const windows = await planStableCommand(options(h, { windows: true, nodePath: 'C:\\node\\node.exe', toolkitRoot: 'C:\\src\\%TEMP%\\nexakit' }));
  assert.match(windows.content, /"C:\\src\\%%TEMP%%\\nexakit\\bin\\nexakit\.js"/u);
});
