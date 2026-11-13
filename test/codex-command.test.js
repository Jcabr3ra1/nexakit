import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
async function run(argv, options = {}, stdin = '') {
  let stdout = '', stderr = '';
  const { runCodexCommand } = await import('../src/codex-command.js');
  const code = await runCodexCommand(argv, { out: s => { stdout += s; }, err: s => { stderr += s; }, input: Readable.from([stdin]) }, options);
  return { code, stdout, stderr };
}
test('strict parsing rejects unknown duplicate missing and positional arguments', async () => {
  for (const argv of [[], ['bogus'], ['consumo', '--json', '--json'], ['auditar', '--project'], ['auditar', '--project', '--json'], ['preparar', '--other'], ['preparar', '--apply', '--apply'], ['comparar', '--antes', 'x'], ['hook', '--json'], ['ejecutar', 'node'], ['consumo', 'extra'], ['consumo', 'toString', 'value']]) {
    assert.equal((await run(argv)).code, 2, argv.join(' '));
  }
});
test('preview CLI and real toolkit route write no personal files', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-cli-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await run(['preparar', '--salida', path.join(root, 'new'), '--json'], { homeDirectory: root });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).applied, false);
  assert.deepEqual(await fs.readdir(root), []);
  const cli = spawnSync(process.execPath, ['bin/nexakit.js', 'codex', 'preparar', '--json'], { encoding: 'utf8', env: { ...process.env, HOME: root, CODEX_HOME: path.join(root, 'codex') } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).applied, false);
  assert.deepEqual(await fs.readdir(root), []);
});
test('hook fails open with bounded stdin and sanitized stderr, stdout JSON only', async () => {
  for (const stdin of ['SECRET bad json', JSON.stringify({ error: 'SECRET' }), 'SECRET' + 'x'.repeat(1024 * 1024)]) {
    const result = await run(['hook'], {}, stdin);
    assert.equal(result.code, 0);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET/);
  }
});
test('compare CLI reads temporary samples and rejects failed quality', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-compare-cli-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = path.join(root, 'before.json'), after = path.join(root, 'after.json');
  const sample = { task: 'test', quality: { passed: true }, measurements: [{ id: '1', agent: 'codex', phase: 'other', model: 'fixture', source: 'manual', totalTokens: 100 }] };
  await fs.writeFile(before, JSON.stringify(sample));
  sample.measurements[0].totalTokens = 50;
  await fs.writeFile(after, JSON.stringify(sample));
  const result = await run(['comparar', '--antes', before, '--despues', after, '--json']);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).counters.totalTokens.percent, 50);
  sample.quality.passed = false;
  await fs.writeFile(after, JSON.stringify(sample));
  assert.equal((await run(['comparar', '--antes', before, '--despues', after])).code, 1);
});

test('consumption text shows principal/subagent coverage and limitations', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-consumption-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { recordCodexUsage } = await import('../src/codex-usage.js');
  recordCodexUsage({ hook_event_name: 'PostModelRequest', session_id: 'fixture', agent_type: 'main', status: 'completed', token_usage: { total_tokens: 100 } }, { homeDirectory: root });
  recordCodexUsage({ hook_event_name: 'PostModelRequest', session_id: 'fixture', agent_id: 'subagent', token_usage: {} }, { homeDirectory: root });
  const result = await run(['consumo'], { homeDirectory: root });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Principal/);
  assert.match(result.stdout, /Subagentes/);
  assert.match(result.stdout, /100.*1\/2/);
  assert.match(result.stdout, /sin.*cobertura|no es telemetría/i);
  const json = await run(['consumo', '--json'], { homeDirectory: root });
  assert.equal(JSON.parse(json.stdout).requests, 2);
});
test('hook session event returns JSON guidance with no extra stdout', async () => {
  const result = await run(['hook'], {}, JSON.stringify({ hook_event_name: 'SessionStart' }));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(result.stderr, '');
});
test('output route preserves literal arguments and child failure code', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-execute-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await run(['ejecutar', '--', process.execPath, '-e', 'console.log(process.argv[1]); process.exitCode = 7', 'literal $(echo no) & ok'], { homeDirectory: root });
  assert.equal(result.code, 7, result.stderr);
  assert.match(result.stdout, /literal \$\(echo no\) & ok/);
});
