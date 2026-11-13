import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCodexHook } from '../src/codex-hook.js';
import { runCodexCommand } from '../src/codex-command.js';
import { prepareCodex } from '../src/codex-setup.js';

async function fixture(t) {
  const homeDirectory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-live-hooks-')));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  return { homeDirectory, environment: {}, now: new Date('2026-11-13T12:00:00Z') };
}
async function activity(options, args = ['--json']) {
  let stdout = '', stderr = '';
  const code = await runCodexCommand(['actividad', ...args], {
    out: text => { stdout += text; }, err: text => { stderr += text; },
  }, options);
  return { code, stdout, stderr };
}
test('lifecycle hook and activity correlate an agent without storing its messages', async t => {
  const options = await fixture(t);
  for (const hook_event_name of ['SubagentStart', 'SubagentStop']) {
    assert.deepEqual(await runCodexHook({ hook_event_name, session_id: 'parent', agent_id: 'child',
      agent_type: 'investigador', model: 'model-fixture', prompt: 'PRIVATE',
      last_assistant_message: 'PRIVATE', agent_transcript_path: '/PRIVATE',
    }, options), {});
  }
  const result = await activity(options);
  assert.equal(result.code, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.events.length, 2);
  assert.ok(report.events.every(event => event.agent_id === 'child'));
  assert.doesNotMatch(result.stdout, /PRIVATE/);
  const text = await activity(options, []);
  assert.match(text.stdout, /investigador/);
  assert.match(text.stdout, /SubagentStart/);
  assert.match(text.stdout, /SubagentStop/);
  assert.equal((await activity(options, ['--apply'])).code, 2);
});
test('new package scopes pre/post tool hooks to Bash and records passive lifecycle events', async t => {
  const options = await fixture(t);
  const plan = await prepareCodex(options);
  const hooks = JSON.parse(plan.files['hooks.json']).hooks;
  assert.equal(hooks.PostToolUse[0].matcher, '^Bash$');
  assert.equal(hooks.PreToolUse[0].matcher, '^Bash$');
  assert.equal(hooks.PostToolUse[0].hooks[0].async, undefined);
  for (const event of ['SubagentStart', 'SubagentStop']) assert.ok(hooks[event]);
});
test('pre-tool integration automatically wraps literal test commands without executing them', { skip: process.platform === 'win32' }, async t => {
  const options = await fixture(t);
  const input = { command: 'npm test', timeout_ms: 1234 };
  const result = await runCodexHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: input }, options);
  assert.equal(result.hookSpecificOutput?.hookEventName, 'PreToolUse');
  assert.equal(result.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(result.hookSpecificOutput.updatedInput.command, /codex.*ejecutar/u);
  assert.equal(result.hookSpecificOutput.updatedInput.timeout_ms, 1234);
  assert.deepEqual(await fs.readdir(options.homeDirectory), []);
  assert.deepEqual(input, { command: 'npm test', timeout_ms: 1234 });
  assert.deepEqual(await runCodexHook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input }, options), {});
});
test('unknown output and failing commands remain unmodified through hook', async t => {
  const options = await fixture(t);
  for (const tool_response of [{ unknown: 'unknown'.repeat(3000) }, { exit_code: 3, output: 'fail'.repeat(4000) }]) {
    assert.deepEqual(await runCodexHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response }, options), {});
  }
});
test('post-tool emits a replacement request without granting permission or blocking the call', async t => {
  const options = await fixture(t);
  const output = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
  const result = await runCodexHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', session_id: 'native-session',
    tool_response: { exit_code: 0, output },
  }, options);
  assert.equal(result.continue, false);
  assert.equal(typeof result.stopReason, 'string');
  assert.ok(result.stopReason.length < output.length);
  assert.match(result.stopReason, /nexakit/);
  assert.equal(result.decision, undefined);
  assert.equal(result.hookSpecificOutput?.permissionDecision, undefined);
});
