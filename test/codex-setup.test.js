import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const setup = async (...args) => (await import('../src/codex-setup.js')).prepareCodex(...args);
async function temporary(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-setup-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('preview is immutable and apply requires explicit new directory', async t => {
  const root = await temporary(t);
  const outputDirectory = path.join(root, 'package with spaces');
  const preview = await setup({ outputDirectory });
  assert.equal(preview.applied, false);
  await assert.rejects(fs.stat(outputDirectory), { code: 'ENOENT' });
  await assert.rejects(setup({ apply: true }));
  const result = await setup({ outputDirectory, apply: true });
  assert.equal(result.applied, true);
  assert.deepEqual((await fs.readdir(outputDirectory)).sort(), ['README.md', 'config.toml', 'hooks.json']);
  const config = await fs.readFile(path.join(outputDirectory, 'config.toml'), 'utf8');
  assert.match(config, /max_context_tokens = 2000/);
  assert.match(config, /tool_output_token_limit = 4000/);
  assert.match(config, /max_concurrent_threads_per_session = 2/);
  assert.doesNotMatch(config, /model|reasoning_effort/);
  const hooks = JSON.parse(await fs.readFile(path.join(outputDirectory, 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PostCompact', 'PostModelRequest', 'PreCompact', 'SessionStart'].sort());
  assert.match(await fs.readFile(path.join(outputDirectory, 'README.md'), 'utf8'), /manual/i);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(outputDirectory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(outputDirectory, 'hooks.json'))).mode & 0o777, 0o600);
  }
  await assert.rejects(setup({ outputDirectory, apply: true }));
  assert.equal(await fs.readFile(path.join(outputDirectory, 'config.toml'), 'utf8'), config);
});
test('rejects symlinks and personal Codex destinations without modifying them', async t => {
  const root = await temporary(t);
  const actual = path.join(root, 'actual');
  await fs.mkdir(actual);
  try { await fs.symlink(actual, path.join(root, 'link'), 'dir'); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { t.skip('Symlink permission unavailable'); return; } throw error; }
  await assert.rejects(setup({ outputDirectory: path.join(root, 'link', 'new'), apply: true }));
  await assert.rejects(setup({ outputDirectory: path.join(root, 'link'), apply: true }));
  await assert.rejects(setup({ outputDirectory: path.join(root, '.codex', 'new'), homeDirectory: root, apply: true }));
  assert.deepEqual(await fs.readdir(actual), []);
});
test('hook command quotes absolute paths with spaces and shell metacharacters', async t => {
  const { buildCodexHookCommand } = await import('../src/codex-setup.js');
  const root = await temporary(t);
  const script = path.join(root, "entry ' $(touch injected).js");
  await fs.writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const command = buildCodexHookCommand({ executable: process.execPath, entrypoint: script });
  if (process.platform !== 'win32') {
    const { stdout } = await promisify(execFile)('/bin/sh', ['-c', command], { cwd: root });
    assert.deepEqual(JSON.parse(stdout), ['codex', 'hook']);
  }
  await assert.rejects(fs.stat(path.join(root, 'injected')), { code: 'ENOENT' });
  const windows = buildCodexHookCommand({ executable: 'C:\\Program Files\\node.exe', entrypoint: 'C:\\app & tools\\bin\\nexakit.js', platform: 'win32' });
  assert.match(windows, /"C:\\Program Files\\node.exe"/);
  assert.throws(() => buildCodexHookCommand({ executable: 'C:\\%BAD%\\node.exe', entrypoint: 'C:\\app\\bin\\nexakit.js', platform: 'win32' }));
});

test('generated hook runs the real absolute CLI in an isolated environment', async t => {
  const { spawnSync } = await import('node:child_process');
  const root = await temporary(t);
  const packagePath = path.join(root, 'manual package');
  await setup({ outputDirectory: packagePath, apply: true, homeDirectory: root });
  const hooks = JSON.parse(await fs.readFile(path.join(packagePath, 'hooks.json'), 'utf8'));
  const command = hooks.hooks.SessionStart[0].hooks[0].command;
  const windows = process.platform === 'win32';
  const result = spawnSync(windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh', windows ? ['/d', '/s', '/c', command] : ['-c', command], {
    cwd: root, input: JSON.stringify({ hook_event_name: 'SessionStart' }), encoding: 'utf8',
    env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, 'personal-codex') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(result.stderr, '');
  assert.deepEqual(await fs.readdir(root), ['manual package']);
});
