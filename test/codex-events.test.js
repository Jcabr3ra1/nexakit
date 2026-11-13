import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { recordCodexAgentEvent, readCodexAgentEvents } from '../src/codex-events.js';

const now = '2026-11-13T12:00:00.000Z';
const event = (extra = {}) => ({ hook_event_name: 'SubagentStart', session_id: 'session-1', agent_id: 'agent-1', agent_type: 'investigador', ...extra });
function fixture(t) {
  const homeDirectory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nexakit-events-'));
  t.after(() => fs.rmSync(homeDirectory, { recursive: true, force: true }));
  return { homeDirectory, now };
}
const directory = (options) => path.join(options.homeDirectory, '.nexakit', 'codex', 'agents');
function symlink(t, target, destination, type = 'dir') {
  try { fs.symlinkSync(target, destination, type); return true; }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows requires symlink privileges.');
    return false;
  }
}

test('stores only versioned allowlisted metadata, with no inferred model', t => {
  const options = fixture(t);
  const record = recordCodexAgentEvent(event({ prompt: 'PRIVATE', transcript: 'PRIVATE', last_assistant_message: 'PRIVATE', cwd: 'PRIVATE', extra: 'PRIVATE' }), options);
  assert.deepEqual(record, { version: 1, recorded_at: now, ...event(), model: null, turn_id: null });
  assert.deepEqual(readCodexAgentEvents(options), [record]);
  const files = fs.readdirSync(directory(options));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}\.jsonl$/u);
  const raw = fs.readFileSync(path.join(directory(options), files[0]), 'utf8');
  assert.equal(raw, `${JSON.stringify(record)}\n`);
  assert.doesNotMatch(raw, /PRIVATE/);
  if (process.platform !== 'win32') {
    for (const part of ['.nexakit', '.nexakit/codex', '.nexakit/codex/agents']) {
      assert.equal(fs.statSync(path.join(options.homeDirectory, part)).mode & 0o777, 0o700);
    }
    assert.equal(fs.statSync(path.join(directory(options), files[0])).mode & 0o777, 0o600);
  }
});

test('accepts Stop, explicit model and turn, date functions, and sorts by instant', t => {
  const options = fixture(t);
  const stop = recordCodexAgentEvent(event({ hook_event_name: 'SubagentStop', model: 'gpt-6.1-sol', turn_id: 'turn' }), { ...options, now: () => now });
  const start = recordCodexAgentEvent(event(), { ...options, now: '2026-11-13T10:00:00Z' });
  assert.deepEqual(readCodexAgentEvents(options), [start, stop]);
});

test('rejects invalid metadata with generic errors and no writes', t => {
  const options = fixture(t);
  const invalid = [null, [], {}, event({ hook_event_name: 'PostModelRequest' })];
  for (const key of ['session_id', 'agent_id', 'agent_type', 'turn_id']) {
    for (const value of ['', ' ', 1, 'PRIVATE\n', 'PRIVATE\u0085', 'x'.repeat(201)]) invalid.push(event({ [key]: value }));
  }
  for (const key of ['session_id', 'agent_id', 'agent_type']) invalid.push(event({ [key]: null }));
  for (const model of ['', 'PRIVATE x', 'PRIVATE\n', '../PRIVATE', 'x'.repeat(101), {}]) invalid.push(event({ model }));
  for (const payload of invalid) {
    assert.throws(() => recordCodexAgentEvent(payload, options), error => error instanceof TypeError && error.message === 'Metadatos de agentes Codex inválidos.');
  }
  assert.throws(() => recordCodexAgentEvent(event(), { ...options, now: 'PRIVATE' }), /Fecha.*inválida/);
  assert.equal(fs.existsSync(directory(options)), false);
  const boundary = recordCodexAgentEvent(event({ session_id: 's'.repeat(200), agent_id: 'a'.repeat(200), agent_type: 't'.repeat(200), turn_id: 'u'.repeat(200), model: 'm'.repeat(100) }), options);
  assert.equal(boundary.model.length, 100);
});

test('absent storage returns an empty snapshot without creating directories', t => {
  const options = fixture(t);
  assert.deepEqual(readCodexAgentEvents(options), []);
  assert.deepEqual(fs.readdirSync(options.homeDirectory), []);
});

test('independent processes preserve every event in exclusive files', async t => {
  const options = fixture(t);
  const moduleUrl = new URL('../src/codex-events.js', import.meta.url).href;
  await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
    const script = `import {recordCodexAgentEvent} from ${JSON.stringify(moduleUrl)}; recordCodexAgentEvent(${JSON.stringify(event({ agent_id: `agent-${i}` }))}, ${JSON.stringify(options)});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)));
  })));
  const records = readCodexAgentEvents(options);
  assert.equal(records.length, 12);
  assert.equal(new Set(records.map(record => record.agent_id)).size, 12);
});

for (const component of ['home', 'ancestor', '.nexakit', 'codex', 'agents']) {
  test(`rejects symlink at ${component} for reads and writes`, t => {
    const options = fixture(t);
    const target = path.join(options.homeDirectory, 'target');
    fs.mkdirSync(target);
    let homeDirectory = options.homeDirectory;
    if (component === 'home' || component === 'ancestor') {
      const link = path.join(options.homeDirectory, 'alias');
      if (!symlink(t, target, link)) return;
      if (component === 'ancestor') fs.mkdirSync(path.join(target, 'home'));
      homeDirectory = component === 'home' ? link : path.join(link, 'home');
    } else {
      const parts = ['.nexakit', 'codex', 'agents'];
      const parent = path.join(homeDirectory, ...parts.slice(0, parts.indexOf(component)));
      fs.mkdirSync(parent, { recursive: true });
      if (!symlink(t, target, path.join(parent, component))) return;
    }
    assert.throws(() => recordCodexAgentEvent(event(), { ...options, homeDirectory }));
    assert.throws(() => readCodexAgentEvents({ ...options, homeDirectory }));
    assert.equal(fs.existsSync(path.join(target, '.nexakit')), false);
    assert.equal(fs.existsSync(path.join(target, 'codex')), false);
  });
}

test('skips malformed, foreign, multiline, and nonregular records; strips extra fields on read', t => {
  const options = fixture(t);
  const record = recordCodexAgentEvent(event(), options);
  const dir = directory(options);
  for (const [name, raw] of Object.entries({ broken: '{PRIVATE', foreign: '{}', multiline: `${JSON.stringify(record)}\n${JSON.stringify(record)}`, version: JSON.stringify({ ...record, version: 2 }), metadata: JSON.stringify({ ...record, agent_id: '\nPRIVATE' }), date: JSON.stringify({ ...record, recorded_at: 'PRIVATE' }) })) {
    fs.writeFileSync(path.join(dir, `${name}.jsonl`), raw);
  }
  fs.mkdirSync(path.join(dir, 'directory.jsonl'));
  fs.writeFileSync(path.join(dir, 'ignored.txt'), JSON.stringify(record));
  fs.writeFileSync(path.join(dir, 'extra.jsonl'), JSON.stringify({ ...record, prompt: 'PRIVATE', cwd: 'PRIVATE' }));
  assert.deepEqual(readCodexAgentEvents(options), [record, record]);
});

test('never reads hardlinked or symlinked records', t => {
  const options = fixture(t);
  const record = recordCodexAgentEvent(event(), options);
  const outside = path.join(options.homeDirectory, 'outside');
  fs.writeFileSync(outside, JSON.stringify(record));
  fs.linkSync(outside, path.join(directory(options), 'hard.jsonl'));
  if (!symlink(t, outside, path.join(directory(options), 'soft.jsonl'), 'file')) return;
  assert.deepEqual(readCodexAgentEvents(options), [record]);
});

test('throws when a regular record exceeds 16KiB and accepts exactly 16KiB', t => {
  const options = fixture(t);
  const record = recordCodexAgentEvent(event(), options);
  const file = path.join(directory(options), 'sized.jsonl');
  const raw = JSON.stringify(record);
  fs.writeFileSync(file, raw.padEnd(16384, ' '));
  assert.equal(readCodexAgentEvents(options).length, 2);
  fs.appendFileSync(file, ' ');
  assert.throws(() => readCodexAgentEvents(options), RangeError);
});

test('counts all directory entries and throws beyond 10000', t => {
  const options = fixture(t);
  recordCodexAgentEvent(event(), options);
  for (let i = 1; i < 10000; i++) fs.writeFileSync(path.join(directory(options), `${i}.txt`), '');
  assert.equal(readCodexAgentEvents(options).length, 1);
  fs.writeFileSync(path.join(directory(options), 'overflow.txt'), '');
  assert.throws(() => readCodexAgentEvents(options), RangeError);
});
