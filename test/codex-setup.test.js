import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTOML, getStaticTOMLValue } from 'toml-eslint-parser';
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
  const settings = getStaticTOMLValue(parseTOML(config));
  assert.equal(Object.hasOwn(settings, 'model'), false);
  assert.equal(Object.hasOwn(settings, 'model_reasoning_effort'), false);
  assert.deepEqual(settings.tui.status_line, ['model-with-reasoning', 'context-remaining',
    'five-hour-limit', 'weekly-limit', 'total-input-tokens', 'total-output-tokens', 'git-branch']);
  const hooks = JSON.parse(await fs.readFile(path.join(outputDirectory, 'hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PostCompact', 'PostModelRequest', 'PreCompact', 'SessionStart', 'UserPromptSubmit'].sort());
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
  const script = path.join(root, "entry & ' $(touch injected).js");
  await fs.writeFile(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
  let executable = process.execPath;
  if (process.platform === 'win32') {
    // Exercise both quoted paths with real cmd.exe in Windows CI, not a POSIX shell.
    executable = path.join(root, 'node & tools', 'node.exe');
    await fs.mkdir(path.dirname(executable));
    await fs.copyFile(process.execPath, executable);
  }
  const command = buildCodexHookCommand({ executable, entrypoint: script });
  const result = spawnSync(command, { shell: true, cwd: root, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['codex', 'hook']);
  assert.equal(result.stderr, '');
  await assert.rejects(fs.stat(path.join(root, 'injected')), { code: 'ENOENT' });
});

test('Windows hook command leaves the /s /c envelope to the shell runner', async () => {
  const { buildCodexHookCommand } = await import('../src/codex-setup.js');
  const windows = buildCodexHookCommand({ executable: 'C:\\Program Files\\node.exe', entrypoint: 'C:\\app & tools\\bin\\nexakit.js', platform: 'win32' });
  assert.equal(windows, '"C:\\Program Files\\node.exe" "C:\\app & tools\\bin\\nexakit.js" codex hook');
});

test('Windows hook rejects variable expansion in either absolute path', async () => {
  const { buildCodexHookCommand } = await import('../src/codex-setup.js');
  for (const character of ['%BAD%', '!BAD!']) {
    for (const key of ['executable', 'entrypoint']) {
      assert.throws(() => buildCodexHookCommand({
        executable: 'C:\\Program Files\\node.exe', entrypoint: 'C:\\app\\nexakit.js',
        [key]: `C:\\${character}\\file`, platform: 'win32',
      }), /Ruta incompatible con quoting seguro en Windows/);
    }
  }
});

test('generated hook runs the real absolute CLI in an isolated environment', async t => {
  const root = await temporary(t);
  const packagePath = path.join(root, 'manual package');
  await setup({ outputDirectory: packagePath, apply: true, homeDirectory: root });
  const hooks = JSON.parse(await fs.readFile(path.join(packagePath, 'hooks.json'), 'utf8'));
  const command = hooks.hooks.SessionStart[0].hooks[0].command;
  const result = spawnSync(command, {
    shell: true, cwd: root, input: JSON.stringify({ hook_event_name: 'SessionStart' }), encoding: 'utf8',
    env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, 'personal-codex') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(result.stderr, '');
  assert.deepEqual(await fs.readdir(root), ['manual package']);
});
