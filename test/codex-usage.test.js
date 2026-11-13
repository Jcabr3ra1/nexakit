import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { recordCodexUsage, readCodexUsage, summarizeCodexUsage } from '../src/codex-usage.js';
import { runCodexHook } from '../src/codex-hook.js';
const now = new Date('2026-11-12T12:00:00Z');
const event = (extra = {}) => ({
  hook_event_name: 'PostModelRequest', session_id: 'session-1', turn_id: 'turn-1',
  agent_id: null, agent_type: 'main', model: 'model-fixture', status: 'completed',
  token_usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 20, total_tokens: 120 },
  ...extra,
});
function fixture(t) {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexakit-codex-usage-'));
  t.after(() => fs.rmSync(homeDirectory, { recursive: true, force: true }));
  return { homeDirectory, codexHome: path.join(homeDirectory, 'custom-codex'), now };
}
const directory = (options) => path.join(options.homeDirectory, '.nexakit/codex/usage');
function symlinkOrSkip(t, target, destination, type) {
  try { fs.symlinkSync(target, destination, type); return true; }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows requires symlink privileges.');
    return false;
  }
}

test('records only allowed metadata and normalizes nested cache without adding it to input', async (t) => {
  assert.equal(typeof recordCodexUsage, 'function');
  const options = fixture(t);
  const record = await recordCodexUsage(event({ prompt: 'PRIVATE', error: 'PRIVATE', arguments: ['PRIVATE'] }), options);
  assert.deepEqual(record.token_usage, { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, total_tokens: 120 });
  assert.equal(record.recorded_at, now.toISOString());
  assert.deepEqual(await readCodexUsage(options), [record]);
  const files = fs.readdirSync(directory(options));
  assert.equal(files.length, 1);
  const raw = fs.readFileSync(path.join(directory(options), files[0]), 'utf8');
  assert.equal(raw.includes('PRIVATE'), false);
  assert.equal(raw.trim().split('\n').length, 1);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(directory(options)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory(options), files[0])).mode & 0o777, 0o600);
  }
  assert.equal(fs.existsSync(options.codexHome), false);
});

test('preserves missing and invalid counters as null, including a null usage object', async (t) => {
  const options = fixture(t);
  for (const token_usage of [null, {}, { input_tokens: -1, cached_input_tokens: '3', output_tokens: Infinity, total_tokens: 1.5 }]) {
    const record = await recordCodexUsage(event({ token_usage }), options);
    assert.deepEqual(record.token_usage, { input_tokens: null, cached_input_tokens: null, output_tokens: null, total_tokens: null });
  }
  const partial = await recordCodexUsage(event({ token_usage: { input_tokens: 0, output_tokens: 7 } }), options);
  assert.deepEqual(partial.token_usage, { input_tokens: 0, cached_input_tokens: null, output_tokens: 7, total_tokens: null });
  const inconsistent = await recordCodexUsage(event({ token_usage: { input_tokens: 5, cached_input_tokens: 6 } }), options);
  assert.equal(inconsistent.token_usage.cached_input_tokens, null);
});

test('uses direct cached input counter and rejects unsafe integer counts', async (t) => {
  const record = await recordCodexUsage(event({ token_usage: { input_tokens: 10, cached_input_tokens: 3, input_tokens_details: { cached_tokens: 9 }, output_tokens: Number.MAX_SAFE_INTEGER + 1 } }), fixture(t));
  assert.equal(record.token_usage.cached_input_tokens, 3);
  assert.equal(record.token_usage.output_tokens, null);
});

test('incompatible reported totals are unknown while partial totals remain available', async (t) => {
  const options = fixture(t);
  const conflicting = await recordCodexUsage(event({ token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, total_tokens: 160 } }), options);
  assert.deepEqual(conflicting.token_usage, { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, total_tokens: null });
  const partial = await recordCodexUsage(event({ token_usage: { input_tokens: 100, total_tokens: 160 } }), options);
  assert.equal(partial.token_usage.total_tokens, 160);
  assert.equal(summarizeCodexUsage([conflicting]).token_usage.total_tokens, null);
  const read = await readCodexUsage(options);
  assert.equal(read.find((record) => record.token_usage.output_tokens === 20).token_usage.total_tokens, null);
});

test('rejects invalid events and bounds metadata without storing their contents', async (t) => {
  const options = fixture(t);
  for (const invalid of [null, [], 'PRIVATE', {}, event({ hook_event_name: 'Other' }), event({ session_id: 'PRIVATE\n' }), event({ model: 'P'.repeat(1025) })]) {
    await assert.rejects(async () => recordCodexUsage(invalid, options), (error) => !error.message.includes('PRIVATE'));
  }
  assert.deepEqual(await readCodexUsage(options), []);
});

test('does not collapse separate events with the same turn id', async (t) => {
  const options = fixture(t);
  await recordCodexUsage(event(), options);
  await recordCodexUsage(event(), options);
  assert.equal((await readCodexUsage(options)).length, 2);
});

test('exclusive files preserve concurrent writes from independent processes', async (t) => {
  assert.equal(typeof recordCodexUsage, 'function');
  const options = fixture(t);
  const moduleUrl = new URL('../src/codex-usage.js', import.meta.url).href;
  await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
    const script = `import { recordCodexUsage } from ${JSON.stringify(moduleUrl)}; await recordCodexUsage(${JSON.stringify(event({ agent_id: `agent-${i}`, agent_type: 'worker' }))}, ${JSON.stringify(options)});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)));
  })));
  const records = await readCodexUsage(options);
  assert.equal(records.length, 12);
  assert.equal(new Set(records.map((record) => record.agent_id)).size, 12);
});

test('refuses symlinked storage directories and never writes into the target', async (t) => {
  const options = fixture(t);
  const target = path.join(options.homeDirectory, 'elsewhere');
  fs.mkdirSync(target);
  if (!symlinkOrSkip(t, target, path.join(options.homeDirectory, '.nexakit'), 'dir')) return;
  await assert.rejects(async () => recordCodexUsage(event(), options));
  assert.deepEqual(fs.readdirSync(target), []);
  await assert.rejects(async () => readCodexUsage(options));
});

test('reader skips malformed, oversized and foreign records', async (t) => {
  const options = fixture(t);
  await recordCodexUsage(event(), options);
  const dir = directory(options);
  fs.writeFileSync(path.join(dir, 'broken.jsonl'), '{secret');
  fs.writeFileSync(path.join(dir, 'large.jsonl'), 'x'.repeat(20000));
  fs.writeFileSync(path.join(dir, 'foreign.jsonl'), JSON.stringify({ prompt: 'PRIVATE' }));
  assert.equal((await readCodexUsage(options)).length, 1);
});

test('reader never follows symlinked record files', async (t) => {
  const options = fixture(t);
  await recordCodexUsage(event(), options);
  const outside = path.join(options.homeDirectory, 'outside');
  fs.writeFileSync(outside, JSON.stringify(event()));
  if (!symlinkOrSkip(t, outside, path.join(directory(options), 'link.jsonl'), 'file')) return;
  assert.equal((await readCodexUsage(options)).length, 1);
});

test('summary separates principal, agents and unknown attribution and exposes partial coverage', async (t) => {
  const options = fixture(t);
  const records = [
    await recordCodexUsage(event(), options),
    await recordCodexUsage(event({ agent_id: 'a', agent_type: 'worker', status: 'failed', token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, total_tokens: 15 } }), options),
    await recordCodexUsage(event({ agent_id: 'a', agent_type: 'worker', token_usage: null }), options),
    await recordCodexUsage(event({ agent_id: null, agent_type: null, token_usage: null }), options),
  ];
  const summary = summarizeCodexUsage(records);
  assert.equal(summary.requests, 4);
  assert.equal(summary.main.requests, 1);
  assert.equal(summary.agents.requests, 2);
  assert.equal(summary.unknown.requests, 1);
  assert.deepEqual(summary.token_usage, { input_tokens: 110, cached_input_tokens: 42, output_tokens: 25, total_tokens: 135 });
  assert.equal(summary.known_counts.input_tokens, 2);
  assert.equal(summary.statuses.failed, 1);
  assert.equal(summary.agents.token_usage.input_tokens, 10);
  assert.equal(summary.unknown.token_usage.total_tokens, null);
  assert.equal('cost' in summary, false);
  assert.ok(summary.limitations.some((message) => message.includes('turn_id')));
  assert.equal(summarizeCodexUsage([]).token_usage.total_tokens, null);
});

test('summary reports overflowing sums as unknown instead of rounded totals', () => {
  const summary = summarizeCodexUsage([event({ token_usage: { input_tokens: Number.MAX_SAFE_INTEGER } }), event({ token_usage: { input_tokens: 1 } })]);
  assert.equal(summary.token_usage.input_tokens, null);
});

test('model request hook records counters with an empty stdout object', async (t) => {
  const options = fixture(t);
  assert.deepEqual(await runCodexHook(event(), options), {});
  assert.equal((await readCodexUsage(options)).length, 1);
});

test('session hook emits bounded additionalContext guidance without storing payloads', async (t) => {
  const options = fixture(t);
  const response = await runCodexHook({ hook_event_name: 'SessionStart', prompt: 'PRIVATE' }, options);
  assert.equal(response.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(typeof response.hookSpecificOutput.additionalContext, 'string');
  assert.ok(JSON.stringify(response).length < 1200);
  assert.equal(JSON.stringify(response).includes('PRIVATE'), false);
  assert.match(response.hookSpecificOutput.additionalContext, /nexakit codex ejecutar/u);
  for (const command of ['/statusline', '/model', '/status']) {
    assert.ok(response.hookSpecificOutput.additionalContext.includes(command));
  }
  assert.deepEqual(await readCodexUsage(options), []);
});

test('compact hooks use only common output fields and preserve authorization to resume', async (t) => {
  const options = fixture(t);
  for (const hook_event_name of ['PostCompact', 'PreCompact']) {
    const response = await runCodexHook({ hook_event_name }, options);
    assert.equal(typeof response.systemMessage, 'string');
    assert.equal('hookSpecificOutput' in response, false);
    assert.match(response.systemMessage, /Retoma el trabajo ya autorizado/u);
  }
  assert.deepEqual(await readCodexUsage(options), []);
});

test('prompt hook never infers context occupancy from tokens or previous requests', async (t) => {
  const options = fixture(t);
  await recordCodexUsage(event({ token_usage: { input_tokens: 2000000 } }), options);
  for (const payload of [{ hook_event_name: 'UserPromptSubmit', prompt: '' }, { hook_event_name: 'UserPromptSubmit', total_tokens: 2000000 }, { hook_event_name: 'Other' }]) {
    assert.deepEqual(await runCodexHook(payload, options), {});
  }
});

test('prompt hook shows one private recommendation using local catalog without changing files', async (t) => {
  const options = { ...fixture(t), includeAntigravity: false };
  options.environment = { CODEX_HOME: options.codexHome, CLAUDE_CONFIG_DIR: path.join(options.homeDirectory, 'claude') };
  fs.mkdirSync(options.codexHome);
  const config = 'model = "diario"\nmodel_reasoning_effort = "medium"\n';
  fs.writeFileSync(path.join(options.codexHome, 'config.toml'), config);
  const catalog = JSON.stringify({ models: [
    { slug: 'diario', description: 'Latest workhorse model for coding', priority: 0, default_reasoning_level: 'medium',
      supported_reasoning_levels: ['low', 'medium', 'high'].map(effort => ({ effort })) },
    { slug: 'frontera', description: 'Frontier intelligence for the most demanding work', priority: 1, default_reasoning_level: 'high',
      supported_reasoning_levels: ['medium', 'high', 'xhigh'].map(effort => ({ effort })) },
  ] });
  fs.writeFileSync(path.join(options.codexHome, 'models_cache.json'), catalog);
  const response = await runCodexHook({ hook_event_name: 'UserPromptSubmit', prompt: 'Investiga una vulnerabilidad de seguridad sutil en autenticación PRIVADO' }, options);
  assert.deepEqual(Object.keys(response), ['systemMessage']);
  assert.equal(typeof response.systemMessage, 'string');
  assert.ok(response.systemMessage.length > 0 && response.systemMessage.length <= 500);
  assert.match(response.systemMessage, /frontera/);
  assert.match(response.systemMessage, /nivel_alto/);
  assert.doesNotMatch(response.systemMessage, /PRIVADO|ocupación|2000000/u);
  for (const prompt of [undefined, '', '  ', 'ok', 'sí', 'gracias']) {
    assert.deepEqual(await runCodexHook({ hook_event_name: 'UserPromptSubmit', prompt }, options), {});
  }
  assert.deepEqual(fs.readdirSync(options.homeDirectory), ['custom-codex']);
  assert.deepEqual(fs.readdirSync(options.codexHome).sort(), ['config.toml', 'models_cache.json']);
  assert.equal(fs.readFileSync(path.join(options.codexHome, 'config.toml'), 'utf8'), config);
  assert.equal(fs.readFileSync(path.join(options.codexHome, 'models_cache.json'), 'utf8'), catalog);
});

test('invalid and unwritable hook payloads fail open with a generic private diagnostic', async (t) => {
  assert.equal(typeof runCodexHook, 'function');
  const options = fixture(t);
  fs.writeFileSync(path.join(options.homeDirectory, '.nexakit'), 'blocked');
  const moduleUrl = new URL('../src/codex-hook.js', import.meta.url).href;
  const script = `import { runCodexHook } from ${JSON.stringify(moduleUrl)}; for (const payload of [null, ${JSON.stringify(event({ error: 'PRIVATE', prompt: 'PRIVATE' }))}]) console.log(JSON.stringify(await runCodexHook(payload, ${JSON.stringify(options)})));`;
  const result = await new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '{}\n{}\n');
  assert.ok(result.stderr.length > 0);
  assert.equal(result.stderr.includes('PRIVATE'), false);
  assert.equal(result.stderr.includes(options.homeDirectory), false);
});

test('session guidance distinguishes installed team UI and model selection from actual delegation', async t => {
  const options = fixture(t);
  const missing = await runCodexHook({ hook_event_name: 'SessionStart' }, options);
  assert.match(missing.hookSpecificOutput.additionalContext, /\/subagents/);
  assert.match(missing.hookSpecificOutput.additionalContext, /principal.*orquesta/i);
  assert.match(missing.hookSpecificOutput.additionalContext, /pequeñas.*direct/i);
  assert.doesNotMatch(missing.hookSpecificOutput.additionalContext, /investigador|nivel_normal/);
  const directory = path.join(options.codexHome, 'agents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'investigador.toml'), 'name = "investigador"\ndescription = "Investiga"\nmodel = "fixture"\nmodel_reasoning_effort = "medium"\ndeveloper_instructions = "Investiga y cita fuentes."\n');
  const installed = await runCodexHook({ hook_event_name: 'SessionStart' }, options);
  assert.match(installed.hookSpecificOutput.additionalContext, /investigador/);
  assert.match(installed.hookSpecificOutput.additionalContext, /\/model/);
  assert.match(installed.hookSpecificOutput.additionalContext, /perfiles instalados.*abrir sesión.*registrados en tus herramientas/i);
});

test('routing inspection failures retain the computed warning and confirmations skip inspection', async t => {
  const options = fixture(t);
  fs.mkdirSync(options.codexHome);
  fs.writeFileSync(path.join(options.codexHome, 'agents'), 'PRIVATE blocked directory');
  const lstat = fs.promises.lstat;
  let inspections = 0, diagnostic = '';
  t.mock.method(fs.promises, 'lstat', async (file, ...args) => {
    if (String(file) === path.join(options.codexHome, 'agents')) {
      inspections++;
      throw new Error('PRIVATE inspection failure');
    }
    return lstat(file, ...args);
  });
  t.mock.method(process.stderr, 'write', text => { diagnostic += text; return true; });
  for (const prompt of ['ok', 'sí', 'gracias']) {
    assert.deepEqual(await runCodexHook({ hook_event_name: 'UserPromptSubmit', prompt }, options), {});
  }
  assert.equal(inspections, 0);
  const response = await runCodexHook({ hook_event_name: 'UserPromptSubmit', prompt: 'Investiga la documentación oficial PRIVADO' }, options);
  assert.ok(inspections > 0);
  assert.ok(response.systemMessage);
  assert.equal('hookSpecificOutput' in response, false);
  assert.doesNotMatch(JSON.stringify(response), /PRIVADO|PRIVATE/);
  const session = await runCodexHook({ hook_event_name: 'SessionStart' }, options);
  assert.match(session.hookSpecificOutput.additionalContext, /\/subagents/);
  assert.ok(diagnostic.length > 0);
  assert.doesNotMatch(diagnostic, /PRIVATE|PRIVADO/);
});

test('prompt routing never names absent or malformed agents', async t => {
  const options = fixture(t);
  const directory = path.join(options.codexHome, 'agents');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'investigador.toml'), 'INVALID PRIVATE');
  const response = await runCodexHook({ hook_event_name: 'UserPromptSubmit', prompt: 'Investiga documentación oficial PRIVADO' }, options);
  assert.ok(response.systemMessage);
  assert.equal('hookSpecificOutput' in response, false);
  assert.doesNotMatch(JSON.stringify(response), /investigador|PRIVADO|PRIVATE/);
});
