import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRevisionInvocation, parseRevisionOutput } from '../src/revision-adapters.js';
const resolve = async () => ({ executable: process.execPath, argsPrefix: ['cli.js'] });
test('review invocation keeps models separate, disables Codex apps and sends prompts on stdin', async () => {
  const c = await buildRevisionInvocation({
    client: 'codex',
    model: 'real-model',
    effort: 'low',
    root: '/repo',
    environment: { PATH: 'test' },
    resolve,
  });
  assert.equal(c.executable, process.execPath);
  assert.ok(c.args.includes('apps'));
  assert.ok(c.args.includes('--ignore-user-config'));
  assert.ok(c.args.includes('read-only'));
  assert.equal(c.args.at(-1), '-');
  const a = await buildRevisionInvocation({
    client: 'antigravity',
    model: 'gemini-3.8-flash-low',
    effort: 'low',
    root: '/repo',
    resolve,
  });
  assert.ok(a.args.includes('--input-format'));
  assert.equal(a.inputFormat, 'stream-json');
  const h = await buildRevisionInvocation({
    client: 'claude',
    model: 'haiku',
    effort: 'low',
    root: '/repo',
    resolve,
  });
  assert.ok(h.args.includes('--strict-mcp-config'));
  assert.ok(h.args.includes('--disallowedTools'));
  assert.ok(h.args.includes('Edit,Write,NotebookEdit,Bash'));
  await assert.rejects(buildRevisionInvocation({ client: 'bad', model: 'x', effort: 'low', resolve }));
});
test('parses Claude provenance and counts without inventing effort or adding cached usage', () => {
  const r = parseRevisionOutput(
    'claude',
    JSON.stringify({
      result: 'Review',
      session_id: 'id',
      modelUsage: {
        haiku: { canonicalModel: 'claude-haiku', inputTokens: 0, outputTokens: 4, cacheReadInputTokens: 8 },
      },
    }),
  );
  assert.equal(r.report, 'Review');
  assert.equal(r.reportedModel, 'claude-haiku');
  assert.equal(r.reportedEffort, null);
  assert.equal(r.usage.inputTokens, 0);
  assert.equal(r.usage.cachedInputTokens, 8);
});
test('parses Codex final messages and per-turn usage, rejects incomplete and malformed runs', () => {
  const events = [
    { type: 'thread.started', thread_id: 'thread' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Report' } },
    { type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 2, cached_input_tokens: 7 } },
  ];
  const r = parseRevisionOutput('codex', events.map(JSON.stringify).join('\n'));
  assert.equal(r.report, 'Report');
  assert.equal(r.executionId, 'thread');
  assert.equal(r.usage.inputTokens, 11);
  assert.equal(r.reportedModel, null);
  for (const raw of ['{bad', JSON.stringify({ type: 'turn.failed' })])
    assert.throws(() => parseRevisionOutput('codex', raw));
});
test('Antigravity denied actions and errors cannot masquerade as a review', () => {
  assert.throws(() =>
    parseRevisionOutput(
      'antigravity',
      JSON.stringify({ status: 'SUCCESS', response: '', denied_actions: [{ action: 'write_file' }] }),
    ),
  );
  const r = parseRevisionOutput(
    'antigravity',
    JSON.stringify({
      status: 'SUCCESS',
      response: 'Report',
      conversation_id: 'id',
      usage: { input_tokens: 5, thinking_tokens: 2, output_tokens: 3 },
    }),
  );
  assert.equal(r.report, 'Report');
  assert.equal(r.reportedModel, null);
  assert.equal(r.usage.thinkingTokens, 2);
  assert.throws(() =>
    parseRevisionOutput('antigravity', JSON.stringify({ status: 'ERROR', response: 'bad' })),
  );
});
test('parses the observed Antigravity stream input/output protocol', () => {
  const raw = [
    { event: 'init', init: { model: 'gemini-3.8-flash-low' } },
    { event: 'step_update', step_update: { text_delta: 'OK' } },
    {
      event: 'result',
      result: {
        status: 'SUCCESS',
        response: 'OK\n',
        conversation_id: 'conversation',
        usage: { input_tokens: 10916, output_tokens: 1, cache_read_tokens: 0, thinking_tokens: 0 },
      },
    },
  ]
    .map(JSON.stringify)
    .join('\n');
  const r = parseRevisionOutput('antigravity', raw);
  assert.equal(r.report, 'OK\n');
  assert.equal(r.reportedModel, 'gemini-3.8-flash-low');
  assert.equal(r.usage.outputTokens, 1);
  assert.equal(r.usage.thinkingTokens, 0);
});
test('absent or invalid counters stay unknown and ambiguous Claude models stay unreported', () => {
  const r = parseRevisionOutput(
    'claude',
    JSON.stringify({
      result: 'Review',
      usage: { input_tokens: -1, output_tokens: '10' },
      modelUsage: { first: {}, second: {} },
    }),
  );
  assert.equal(r.usage.inputTokens, null);
  assert.equal(r.usage.outputTokens, null);
  assert.equal(r.usage.cachedInputTokens, null);
  assert.equal(r.reportedModel, null);
});
