import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const hookUrl = new URL('../src/antigravity-hook.js', import.meta.url);
const preToolUrl = new URL('../src/antigravity-pre-tool.js', import.meta.url);
const runHook = async (...args) => (await import(hookUrl)).runAntigravityHook(...args);

test('PreToolUse enforces guardarrailes on run_command, write_file, and edit_file', async (t) => {
  const homeDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-guard-')));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  const rmRoot = await runHook({
    hookEventName: 'PreToolUse',
    conversationId: 'conv-g1',
    toolCall: { id: 't1', name: 'run_command', args: { CommandLine: 'rm -rf /' } },
  }, { homeDirectory });
  assert.equal(rmRoot.decision, 'deny');
  assert.match(rmRoot.reason, /comando peligroso/iu);

  const badCommit = await runHook({
    hookEventName: 'PreToolUse',
    conversationId: 'conv-g1',
    toolCall: { id: 't2', name: 'run_command', args: { CommandLine: 'git commit -m "Arreglado todo."' } },
  }, { homeDirectory });
  assert.equal(badCommit.decision, 'deny');
  assert.match(badCommit.reason, /formato del commit/iu);

  const secretWrite = await runHook({
    hookEventName: 'PreToolUse',
    conversationId: 'conv-g1',
    toolCall: { id: 't3', name: 'write_file', args: { Path: '/tmp/app/.env', Content: 'API_KEY=sk-1234567890abcdef' } },
  }, { homeDirectory });
  assert.equal(secretWrite.decision, 'deny');
  assert.match(secretWrite.reason, /protección de secretos/iu);

  const secretEdit = await runHook({
    hookEventName: 'PreToolUse',
    conversationId: 'conv-g1',
    toolCall: { id: 't4', name: 'edit_file', args: { Path: '/tmp/app/config.js', Target: 'x', Replacement: 'sk-1234567890abcdef1234' } },
  }, { homeDirectory });
  assert.equal(secretEdit.decision, 'deny');
  assert.match(secretEdit.reason, /protección de secretos/iu);
});

test('PreToolUse rewrites approved run_command for ahorro when safe and non-daemon, preserving daemons and bypasses', async (t) => {
  const homeDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-ahorro-')));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  const wrapped = await runHook({
    hookEventName: 'PreToolUse',
    conversationId: 'conv-a1',
    toolCall: { id: 't1', name: 'run_command', args: { CommandLine: 'npm test', IsDaemon: false } },
  }, {
    homeDirectory,
    platform: 'darwin',
    executable: '/usr/local/bin/node',
    entrypoint: '/opt/nexakit/bin/nexakit.js',
  });
  assert.equal(wrapped.decision, 'allow');
  assert.match(wrapped.overwrite.CommandLine, /^NEXAKIT_ANTIGRAVITY_TEMP_OUTPUT=1 '\/usr\/local\/bin\/node' '\/opt\/nexakit\/bin\/nexakit\.js' 'antigravity' 'ejecutar' '--' 'npm' 'test'$/u);

  const { unwrapAntigravityCommand } = await import(preToolUrl);
  assert.equal(unwrapAntigravityCommand(wrapped.overwrite.CommandLine), 'npm test');

  const daemon = await runHook({
    hookEventName: 'PreToolUse',
    conversationId: 'conv-a1',
    toolCall: { id: 't2', name: 'run_command', args: { CommandLine: 'npm test', IsDaemon: true } },
  }, { homeDirectory, platform: 'darwin' });
  assert.equal(daemon.decision, 'allow');
  assert.equal(daemon.overwrite, undefined);

  const bypass = await runHook({
    hookEventName: 'PreToolUse',
    conversationId: 'conv-a1',
    toolCall: { id: 't3', name: 'run_command', args: { CommandLine: 'npm test' } },
  }, { homeDirectory, platform: 'darwin', environment: { NEXAKIT_SALIDA: 'completa' } });
  assert.equal(bypass.decision, 'allow');
  assert.equal(bypass.overwrite, undefined);
});

test('PreToolUse and PostToolUse enforce lecciones duplicate failure blocking and 3rd error repetition notice', async (t) => {
  const homeDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agy-lec-')));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));

  // First failure on wrapped npm test records normalized failure for 'npm test'.
  const wrappedCmd = "NEXAKIT_ANTIGRAVITY_TEMP_OUTPUT=1 '/usr/local/bin/node' '/opt/nexakit/bin/nexakit.js' 'antigravity' 'ejecutar' '--' 'npm' 'test'";
  assert.deepEqual(await runHook({
    hookEventName: 'PostToolUse',
    conversationId: 'conv-l1',
    toolCall: { id: 't1', name: 'run_command', args: { CommandLine: wrappedCmd } },
    error: 'FAIL test/a.test.js line 12',
  }, { homeDirectory, now: 1_700_000_000_000 }), {});

  // Immediate retry of npm test is blocked unless NEXAKIT_REPETIR=1 is set.
  const blocked = await runHook({
    hookEventName: 'PreToolUse',
    conversationId: 'conv-l1',
    toolCall: { id: 't2', name: 'run_command', args: { CommandLine: 'npm test' } },
  }, { homeDirectory, now: 1_700_000_001_000 });
  assert.equal(blocked.decision, 'deny');
  assert.match(blocked.reason, /ya falló así.*NEXAKIT_REPETIR=1/us);

  // Editing a file clears the failure state so retry is allowed again.
  assert.deepEqual(await runHook({
    hookEventName: 'PostToolUse',
    conversationId: 'conv-l1',
    toolCall: { id: 't3', name: 'edit_file', args: { Path: '/tmp/a.js', Target: 'a', Replacement: 'b' } },
  }, { homeDirectory, now: 1_700_000_002_000 }), {});

  const allowedAgain = await runHook({
    hookEventName: 'PreToolUse',
    conversationId: 'conv-l1',
    toolCall: { id: 't4', name: 'run_command', args: { CommandLine: 'npm test' } },
  }, { homeDirectory, platform: 'darwin', now: 1_700_000_003_000 });
  assert.equal(allowedAgain.decision, 'allow');

  // 2 more failures of the same normalized error key trigger repetition warning on next PreInvocation.
  for (const [idx, cmd] of [['t5', 'npm run lint'], ['t6', 'npm run check']]) {
    await runHook({
      hookEventName: 'PostToolUse',
      conversationId: 'conv-l1',
      toolCall: { id: idx, name: 'run_command', args: { CommandLine: cmd } },
      error: 'FAIL test/a.test.js line 99',
    }, { homeDirectory, now: 1_700_000_004_000 });
  }

  const nextTurn = await runHook({
    hookEventName: 'PreInvocation',
    conversationId: 'conv-l1',
    modelName: 'auto',
    lastUserInput: 'continúa',
  }, { homeDirectory, now: 1_700_000_005_000 });
  const text = nextTurn.injectSteps.map((s) => s.systemMessage.systemMessage).join('\n');
  assert.match(text, /mismo tipo de error salió 3 veces/u);

  const ledger = await fs.readFile(path.join(homeDirectory, '.nexakit', 'lecciones.jsonl'), 'utf8');
  assert.match(ledger, /"tipo":"freno"/u);
  assert.match(ledger, /"tipo":"repeticion"/u);
  const repeticion = ledger.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.tipo === 'repeticion');
  assert.equal(repeticion.clave, 'FAIL test<ruta> line #', 'la repetición lleva la clave del error');
});
