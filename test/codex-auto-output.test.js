import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compactCodexToolOutput } from '../src/codex-auto-output.js';

const long = Array.from({ length: 1000 }, (_, i) => `línea ${i}`).join('\n');
const event = (tool_response, extra = {}) => ({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'NO_EJECUTAR secreto' }, prompt: 'PROMPT_PRIVADO', tool_response, ...extra });
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'auto-output-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { homeDirectory: home, environment: {} };
}
const folder = options => path.join(options.homeDirectory, '.nexakit/codex/salidas');

test('successful string saves exact UTF-8 original and emits only the replacement contract', async t => {
  const options = await fixture(t);
  const original = `Process exited with code 0\nFinal output:\n${long}\nERROR diagnóstico á🚀\n`;
  const result = await compactCodexToolOutput(event(original), options);
  assert.deepEqual(Object.keys(result).sort(), ['continue', 'stopReason']);
  assert.equal(result.continue, false);
  assert.match(result.stopReason, /exit_code\s*[:=]?\s*0/u);
  assert.match(result.stopReason, /ERROR diagnóstico á🚀/u);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < Buffer.byteLength(original));
  const files = await fs.readdir(folder(options));
  assert.equal(files.length, 1);
  const file = path.join(folder(options), files[0]);
  assert.ok(result.stopReason.includes(file));
  assert.deepEqual(await fs.readFile(file), Buffer.from(original));
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /NO_EJECUTAR|PROMPT_PRIVADO/u);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    for (const dir of ['.nexakit', '.nexakit/codex', '.nexakit/codex/salidas']) {
      assert.equal((await fs.stat(path.join(options.homeDirectory, dir))).mode & 0o777, 0o700);
    }
  }
});

test('both successful object formats save JSON and describe its format', async t => {
  const options = await fixture(t);
  for (const response of [{ exit_code: 0, output: long }, { stdout: long, stderr: 'diagnóstico', exit_code: 0 }]) {
    const result = await compactCodexToolOutput(event(response), options);
    assert.equal(result.continue, false);
    assert.match(result.stopReason, /JSON/u);
    const files = await fs.readdir(folder(options));
    const saved = await Promise.all(files.map(file => fs.readFile(path.join(folder(options), file), 'utf8')));
    assert.ok(saved.includes(JSON.stringify(response)));
    if ('stderr' in response) assert.match(result.stopReason, /diagnóstico/u);
  }
  assert.equal((await fs.readdir(folder(options))).length, 2);
});

test('hook session metadata does not mark a completed response as a live process', async t => {
  const options = await fixture(t);
  const result = await compactCodexToolOutput(event({ exit_code: 0, output: long }, { session_id: 'hook-session', cwd: '/private' }), options);
  assert.equal(result.continue, false);
  const [name] = await fs.readdir(folder(options));
  assert.doesNotMatch(await fs.readFile(path.join(folder(options), name), 'utf8'), /hook-session|private/u);
});

test('native plain text preserves original and never invents a successful exit code', async t => {
  const options = await fixture(t);
  const result = await compactCodexToolOutput(event(long, { session_id: 'native-session' }), options);
  assert.equal(result.continue, false);
  assert.match(result.stopReason, /exit_code: desconocido/u);
  assert.doesNotMatch(result.stopReason, /exit_code: 0/u);
  const [name] = await fs.readdir(folder(options));
  assert.equal(await fs.readFile(path.join(folder(options), name), 'utf8'), long);
});

test('native errors, truncated text and ambiguous process envelopes remain untouched', async t => {
  const options = await fixture(t);
  for (const response of [`${long}\nERROR occurred`, `Warning: truncated output\n${long}`,
    `Process exited with code 2\n${long}`, `Process running with session ID 3\n${long}`]) {
    assert.deepEqual(await compactCodexToolOutput(event(response), options), {});
  }
  await assert.rejects(fs.stat(folder(options)), { code: 'ENOENT' });
});

test('unknown, failed, live and malformed responses cause no writes', async t => {
  const options = await fixture(t);
  const valid = { exit_code: 0, output: long };
  const responses = [null, [], {}, { output: long }, { ...valid, exit_code: '0' },
    { ...valid, exit_code: 1 }, { ...valid, session_id: null }, { ...valid, signal: null },
    { ...valid, isError: true }, { ...valid, interrupted: true },
    { ...valid, backgroundTaskId: 'live' }, { ...valid, stdout: long },
    { stdout: long, exit_code: 0 }, { stdout: long, stderr: 1, exit_code: 0 },
    `Process exited with code 1\nFinal output:\n${long}`,
    `Process running with session ID 1\nFinal output:\n${long}`,
    `Process exited with code 0\nUnknown metadata\nFinal output:\n${long}`];
  for (const response of responses) assert.deepEqual(await compactCodexToolOutput(event(response), options), {});
  for (const payload of [null, [], {}, event(valid, { tool_name: 'Read' }), event(valid, { hook_event_name: 'PreToolUse' }), event(valid, { isError: true })]) {
    assert.deepEqual(await compactCodexToolOutput(payload, options), {});
  }
  await assert.rejects(fs.stat(folder(options)), { code: 'ENOENT' });
});

test('bypasses environment and literal command prefix without shell interpretation', async t => {
  const options = await fixture(t);
  const payload = event({ output: long, exit_code: 0 });
  assert.deepEqual(await compactCodexToolOutput(payload, { ...options, environment: { NEXAKIT_SALIDA: 'completa' } }), {});
  assert.deepEqual(await compactCodexToolOutput({ ...payload, tool_input: { command: '  NEXAKIT_SALIDA=completa npm test' } }, options), {});
  assert.equal((await compactCodexToolOutput({ ...payload, tool_input: { command: 'echo NEXAKIT_SALIDA=completa' } }, options)).continue, false);
});

test('short responses, oversized UTF-8 and summaries larger than original stay untouched', async t => {
  const options = await fixture(t);
  for (const response of [{ output: 'hola', exit_code: 0 }, { output: 'á'.repeat(524288), exit_code: 0 },
    { output: Array(121).fill('x').join('\n'), exit_code: 0 }]) {
    assert.deepEqual(await compactCodexToolOutput(event(response), options), {});
  }
  await assert.rejects(fs.stat(folder(options)), { code: 'ENOENT' });
});

test('one MiB byte boundary is inclusive for exact string originals', async t => {
  const options = await fixture(t);
  const header = 'Process exited with code 0\nFinal output:\n';
  const original = header + 'x'.repeat(1024 * 1024 - Buffer.byteLength(header));
  assert.equal((await compactCodexToolOutput(event(original), options)).continue, false);
  assert.deepEqual(await compactCodexToolOutput(event(original + 'x'), options), {});
});

test('storage failures and symlinks in each path component fail open', async t => {
  const options = await fixture(t);
  const payload = event({ output: long, exit_code: 0 });
  const blocker = path.join(options.homeDirectory, 'file');
  await fs.writeFile(blocker, 'unchanged');
  assert.deepEqual(await compactCodexToolOutput(payload, { ...options, homeDirectory: blocker }), {});
  assert.equal(await fs.readFile(blocker, 'utf8'), 'unchanged');
  if (process.platform === 'win32') return;
  const target = path.join(options.homeDirectory, 'target');
  await fs.mkdir(target);
  for (const component of ['', '.nexakit', '.nexakit/codex', '.nexakit/codex/salidas']) {
    const root = path.join(options.homeDirectory, `case-${component.length}`);
    await fs.mkdir(root);
    const link = component ? path.join(root, component) : path.join(root, 'home');
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link);
    assert.deepEqual(await compactCodexToolOutput(payload, { ...options, homeDirectory: component ? root : link }), {});
    assert.deepEqual(await fs.readdir(target), []);
  }
});

test('existing permissive output directories become private', { skip: process.platform === 'win32' }, async t => {
  const options = await fixture(t);
  await fs.mkdir(folder(options), { recursive: true, mode: 0o755 });
  for (const dir of ['.nexakit', '.nexakit/codex', '.nexakit/codex/salidas']) {
    await fs.chmod(path.join(options.homeDirectory, dir), 0o755);
  }
  assert.equal((await compactCodexToolOutput(event({ exit_code: 0, output: long }), options)).continue, false);
  for (const dir of ['.nexakit', '.nexakit/codex', '.nexakit/codex/salidas']) {
    assert.equal((await fs.stat(path.join(options.homeDirectory, dir))).mode & 0o777, 0o700);
  }
});

test('failed original write returns no replacement and removes incomplete file', async t => {
  const options = await fixture(t);
  const mock = t.mock.method(fsSync, 'writeFileSync', () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  try {
    assert.deepEqual(await compactCodexToolOutput(event({ exit_code: 0, output: long }), options), {});
  } finally { mock.mock.restore(); }
  assert.deepEqual(await fs.readdir(folder(options)), []);
});

test('exclusive creation rejects colliding symlinks and hardlinks without changing targets', { skip: process.platform === 'win32' }, async t => {
  const options = await fixture(t);
  const target = path.join(options.homeDirectory, 'target');
  await fs.writeFile(target, 'untouched');
  for (const link of ['symlinkSync', 'linkSync']) {
    const open = fsSync.openSync;
    const mock = t.mock.method(fsSync, 'openSync', (file, ...args) => {
      fsSync[link](target, file);
      return open(file, ...args);
    });
    try {
      assert.deepEqual(await compactCodexToolOutput(event({ exit_code: 0, output: long }), options), {});
    } finally { mock.mock.restore(); }
    assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
  }
});
