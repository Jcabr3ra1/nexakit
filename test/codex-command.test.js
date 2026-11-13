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

async function recommendationFixture(t, withCatalog = true) {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-recommend-cli-'));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  const codexHome = path.join(homeDirectory, 'codex');
  await fs.mkdir(codexHome);
  await fs.writeFile(path.join(codexHome, 'config.toml'), 'model = "diario"\nmodel_reasoning_effort = "medium"\n');
  if (withCatalog) await fs.writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'diario', description: 'Latest workhorse model for coding', priority: 0, default_reasoning_level: 'medium',
      supported_reasoning_levels: ['low', 'medium', 'high'].map(effort => ({ effort })) },
    { slug: 'frontera', description: 'Frontier intelligence for the most demanding work', priority: 1, default_reasoning_level: 'high',
      supported_reasoning_levels: ['medium', 'high', 'xhigh'].map(effort => ({ effort })) },
  ] }));
  return { homeDirectory, codexHome, includeAntigravity: false,
    environment: { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: path.join(homeDirectory, 'claude') } };
}

test('recommend CLI rejects missing blank duplicate unknown and positional arguments', async () => {
  for (const argv of [[], ['--tarea'], ['--tarea', ''], ['--tarea', '  '], ['--tarea', '--json'],
    ['--tarea', 'x', '--tarea', 'y'], ['--tarea', 'x', '--json', '--json'],
    ['--tarea', 'x', '--unknown'], ['--tarea', 'x', 'extra']]) {
    assert.equal((await run(['recomendar', ...argv])).code, 2, argv.join(' '));
  }
  assert.match((await run(['--help'])).stdout, /recomendar --tarea/);
});

test('recommend CLI reports real catalog and stored settings privately in text and JSON', async t => {
  const options = await recommendationFixture(t);
  const before = await fs.readFile(path.join(options.codexHome, 'config.toml'), 'utf8');
  const task = 'Investiga una vulnerabilidad de seguridad sutil en autenticación PRIVADO';
  const result = await run(['recomendar', '--tarea', task, '--json'], options);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.available, true);
  assert.equal(report.silent, false);
  assert.equal(report.source, 'local-catalog');
  assert.equal(report.automaticChange, false);
  assert.deepEqual(report.stored, { model: 'diario', effort: 'medium' });
  assert.ok(['diario', 'frontera'].includes(report.recommendation.model));
  assert.ok(report.reason);
  const text = await run(['recomendar', '--tarea', task], options);
  assert.equal(text.code, 0, text.stderr);
  assert.ok(text.stdout.includes(report.recommendation.model));
  assert.ok(text.stdout.includes(report.reason));
  assert.match(text.stdout, /local-catalog/);
  assert.match(text.stdout, /guardad/i);
  assert.doesNotMatch(result.stdout + text.stdout + text.stderr, /PRIVADO/);
  assert.equal(await fs.readFile(path.join(options.codexHome, 'config.toml'), 'utf8'), before);
  assert.deepEqual(await fs.readdir(options.homeDirectory), ['codex']);
  assert.deepEqual((await fs.readdir(options.codexHome)).sort(), ['config.toml', 'models_cache.json']);
});

test('recommend CLI reports missing catalog honestly with exit zero', async t => {
  const options = await recommendationFixture(t, false);
  const result = await run(['recomendar', '--tarea', 'Revisa seguridad PRIVADO', '--json'], options);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.available, false);
  assert.equal(report.recommendation, null);
  assert.equal(report.automaticChange, false);
  assert.ok(report.message);
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVADO/);
  const text = await run(['recomendar', '--tarea', 'Revisa seguridad PRIVADO'], options);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /no disponible/);
  assert.doesNotMatch(text.stdout, /PRIVADO/);
});

test('recommend CLI unexpected errors return one with a generic private diagnostic', async () => {
  const result = await run(['recomendar', '--tarea', 'Implementa PRIVADO', '--json'], {
    get environment() { throw new Error('PRIVADO'); },
  });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /No se pudo completar/);
  assert.doesNotMatch(result.stderr, /PRIVADO/);
});

test('prompt stdin returns JSON only, keeps confirmations silent and never stores private text', async t => {
  const options = await recommendationFixture(t);
  const config = await fs.readFile(path.join(options.codexHome, 'config.toml'), 'utf8');
  const result = await run(['hook'], options, JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'Revisa una vulnerabilidad de seguridad PRIVADO' }));
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.ok(JSON.parse(result.stdout).systemMessage);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.doesNotMatch(result.stdout, /PRIVADO/);
  const silent = await run(['hook'], options, JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'ok' }));
  assert.equal(silent.stdout, '{}\n');
  assert.equal(silent.stderr, '');
  const cli = spawnSync(process.execPath, ['bin/nexakit.js', 'codex', 'hook'], {
    encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'Investiga seguridad PRIVADO' }),
    env: { ...process.env, HOME: options.homeDirectory, CODEX_HOME: options.codexHome,
      CLAUDE_CONFIG_DIR: options.environment.CLAUDE_CONFIG_DIR },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, '');
  assert.match(JSON.parse(cli.stdout).systemMessage, /frontera/);
  assert.equal(cli.stdout.trim().split('\n').length, 1);
  assert.doesNotMatch(cli.stdout, /PRIVADO/);
  for (const stdin of [JSON.stringify([]), JSON.stringify('PRIVADO'), JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'PRIVADO' + 'x'.repeat(1024 * 1024) })]) {
    const invalid = await run(['hook'], options, stdin);
    assert.equal(invalid.code, 0);
    assert.equal(invalid.stdout, '{}\n');
    assert.ok(invalid.stderr);
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /PRIVADO/);
  }
  assert.equal(await fs.readFile(path.join(options.codexHome, 'config.toml'), 'utf8'), config);
  assert.deepEqual(await fs.readdir(options.homeDirectory), ['codex']);
  assert.deepEqual((await fs.readdir(options.codexHome)).sort(), ['config.toml', 'models_cache.json']);
});
