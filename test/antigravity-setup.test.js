import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const setupUrl = new URL('../src/antigravity-setup.js', import.meta.url);
const prepare = async (...args) => (await import(setupUrl)).prepareAntigravity(...args);
const buildCmd = async (...args) => (await import(setupUrl)).buildAntigravityCommand(...args);

async function temporary(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-setup-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('preview is immutable and apply requires an explicit new directory outside .gemini and .agents', async (t) => {
  const root = await temporary(t);
  const outDir = path.join(root, 'package with spaces');

  const preview = await prepare({ outputDirectory: outDir, homeDirectory: root, projectRoot: root });
  assert.equal(preview.applied, false);
  await assert.rejects(fs.stat(outDir), { code: 'ENOENT' });
  await assert.rejects(prepare({ apply: true }));

  const applied = await prepare({ outputDirectory: outDir, apply: true, homeDirectory: root, projectRoot: root });
  assert.equal(applied.applied, true);
  assert.deepEqual((await fs.readdir(outDir)).sort(), ['README.md', 'agents', 'hooks.json', 'plugin.json', 'settings.statusline.json']);
  assert.equal((await fs.readdir(path.join(outDir, 'agents'))).length, 10);

  const settings = JSON.parse(await fs.readFile(path.join(outDir, 'settings.statusline.json'), 'utf8'));
  assert.equal(settings.statusLine.type, 'command');
  assert.match(settings.statusLine.command, /antigravity barra$/u);

  const hooks = JSON.parse(await fs.readFile(path.join(outDir, 'hooks.json'), 'utf8'));
  assert.equal(hooks['nexakit-antigravity'].SessionStart[0].type, 'command');
  assert.equal(hooks['nexakit-antigravity'].SessionStart[0].timeout, 5);
  assert.equal(hooks['nexakit-antigravity'].PreInvocation[0].type, 'command');
  assert.equal(hooks['nexakit-antigravity'].PreInvocation[0].timeout, 5);
  assert.equal(hooks['nexakit-antigravity'].PreToolUse[0].hooks[0].type, 'command');
  assert.equal(hooks['nexakit-antigravity'].PostToolUse[0].hooks[0].type, 'command');
  assert.match(hooks['nexakit-antigravity'].PreInvocation[0].command, /antigravity hook$/u);

  const which = spawnSync('which', ['agy'], { encoding: 'utf8' });
  if (which.status === 0) {
    const validate = spawnSync('agy', ['plugin', 'validate', '--strict', outDir], { encoding: 'utf8' });
    assert.equal(validate.status, 0, validate.stdout + validate.stderr);
  }

  if (process.platform === 'darwin') {
    const tmpPkg = path.join('/tmp', `agy-darwin-${process.pid}-${Date.now()}`);
    t.after(() => fs.rm(tmpPkg, { recursive: true, force: true }));
    const onTmp = await prepare({ outputDirectory: tmpPkg, apply: true, homeDirectory: root, projectRoot: root });
    assert.equal(onTmp.applied, true);
  }

  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(outDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(outDir, 'hooks.json'))).mode & 0o777, 0o600);
  }

  await assert.rejects(prepare({ outputDirectory: outDir, apply: true, homeDirectory: root, projectRoot: root }));
  await assert.rejects(prepare({ outputDirectory: path.join(root, '.gemini', 'pkg'), apply: true, homeDirectory: root, projectRoot: root }));
  await assert.rejects(prepare({ outputDirectory: path.join(root, '.agents', 'pkg'), apply: true, homeDirectory: root, projectRoot: root }));
});

test('rejects symlink ancestors and quotes POSIX and Windows commands safely', async (t) => {
  const root = await temporary(t);
  const actual = path.join(root, 'actual');
  await fs.mkdir(actual);
  try {
    await fs.symlink(actual, path.join(root, 'link'), 'dir');
    await assert.rejects(prepare({ outputDirectory: path.join(root, 'link', 'new'), apply: true, homeDirectory: root, projectRoot: root }));
  } catch (error) {
    if (!(process.platform === 'win32' && error.code === 'EPERM')) throw error;
  }

  const win = await buildCmd('barra', {
    executable: 'C:\\Program Files\\node.exe',
    entrypoint: 'C:\\app & tools\\bin\\nexakit.js',
    platform: 'win32',
  });
  assert.equal(win, '"C:\\Program Files\\node.exe" "C:\\app & tools\\bin\\nexakit.js" antigravity barra');

  await assert.rejects(
    buildCmd('hook', { executable: 'C:\\node.exe', entrypoint: 'C:\\%BAD%\\nexakit.js', platform: 'win32' }),
    /Windows/u,
  );

  const posixQuoted = await buildCmd('barra', {
    executable: '/opt/node & bin/node',
    entrypoint: "/tmp/entry & ' $(touch injected).js",
    platform: 'posix',
  });
  assert.equal(posixQuoted, "'/opt/node & bin/node' '/tmp/entry & '\\'' $(touch injected).js' antigravity barra");

  const script = path.join(root, "entry & ' $(touch injected).js");
  await fs.writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const hostCmd = await buildCmd('barra', {
    executable: process.execPath,
    entrypoint: script,
    platform: process.platform === 'win32' ? 'win32' : 'posix',
  });
  const run = spawnSync(hostCmd, { shell: true, cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ['antigravity', 'barra']);
  await assert.rejects(fs.stat(path.join(root, 'injected')), { code: 'ENOENT' });
});

test('generated hooks.json and statusLine commands work end-to-end in an isolated environment', async (t) => {
  const root = await temporary(t);
  const pkgDir = path.join(root, 'manual package');
  await prepare({ outputDirectory: pkgDir, apply: true, homeDirectory: root, projectRoot: root });

  const settings = JSON.parse(await fs.readFile(path.join(pkgDir, 'settings.statusline.json'), 'utf8'));
  const hooks = JSON.parse(await fs.readFile(path.join(pkgDir, 'hooks.json'), 'utf8'));
  const hookCmd = hooks['nexakit-antigravity'].PreInvocation[0].command;
  const barCmd = settings.statusLine.command;
  const env = { ...process.env, HOME: root, USERPROFILE: root };

  const hookRun = spawnSync(hookCmd, {
    shell: true,
    cwd: root,
    encoding: 'utf8',
    env,
    input: JSON.stringify({
      hookEventName: 'PreInvocation',
      conversationId: 'e2e-conv',
      modelName: 'auto',
      lastUserInput: 'Diseña la arquitectura de colas',
    }),
  });
  assert.equal(hookRun.status, 0, hookRun.stderr);
  assert.equal(JSON.parse(hookRun.stdout).injectSteps[0].systemMessage.systemMessage, '');

  const barRun = spawnSync(barCmd, {
    shell: true,
    cwd: root,
    encoding: 'utf8',
    env: { ...env, NO_COLOR: '1' },
    input: JSON.stringify({
      conversation_id: 'e2e-conv',
      model: { id: 'Gemini 4 Hydrogen (Medium)', display_name: 'Gemini 4 Hydrogen (Medium)', effort: 'medium' },
      context_window: { used_percentage: 25 },
      quota: { default: { remaining_fraction: 0.7 } },
    }),
  });
  assert.equal(barRun.status, 0, barRun.stderr);
  assert.match(barRun.stdout, /^Gemini 4 Hydrogen · medium  → Carbon · high/u);
  assert.match(barRun.stdout, /ctx ▰▰▰▱▱▱▱▱▱▱ 25%/u);
  assert.match(barRun.stdout, /cuota 30%/u);
});
