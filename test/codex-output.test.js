import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runAhorroCommand } from '../src/ahorro-command.js';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { runCodexOutput } from '../src/codex-output.js';
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'codex-output-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let stdout = '', stderr = '';
  return { home, io: { out: { write: x => { stdout += x; } }, err: { write: x => { stderr += x; } } },
    out: () => stdout, err: () => stderr, options: { homeDirectory: home, tempDirectory: home } };
}
const node = code => [process.execPath, '-e', code];
async function logs(f) {
  const dir = path.join(f.home, '.nexakit', 'salidas');
  return Promise.all((await fs.readdir(dir)).map(async name => ({ path: path.join(dir, name), text: await fs.readFile(path.join(dir, name), 'utf8') })));
}

test('exports the executor contract', () => assert.equal(typeof runCodexOutput, 'function'));
test('automatic mode stores privately in allowed temporary storage without touching the user home', async t => {
  const f = await fixture(t);
  const temporary = path.join(f.home, 'temporary');
  await fs.mkdir(temporary);
  const expected = 'automatic output\n'.repeat(400);
  assert.equal(await runCodexOutput(node(`process.stdout.write(${JSON.stringify(expected)})`), f.io, {
    ...f.options, tempDirectory: temporary, env: { NEXAKIT_CODEX_TEMP_OUTPUT: '1' },
  }), 0);
  assert.match(f.out(), /líneas omitidas/u);
  const privateRoot = path.join(temporary, `nexakit-codex-${process.getuid?.() ?? 'user'}`, '.nexakit', 'salidas');
  const [name] = await fs.readdir(privateRoot);
  assert.equal(await fs.readFile(path.join(privateRoot, name), 'utf8'), expected);
  await assert.rejects(fs.stat(path.join(f.home, '.nexakit')), { code: 'ENOENT' });
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(privateRoot, name))).mode & 0o777, 0o600);
});
test('spools >10MiB, keeps head/tail/errors and exit 7 with bounded summary and private metrics', async t => {
  const f = await fixture(t);
  const code = `process.stdout.write('HEAD\\n'); for(let i=0;i<12000;i++) process.stdout.write('x'.repeat(1024)+'\\n'); process.stdout.write('ERROR middle\\n'); for(let i=0;i<300;i++) process.stdout.write('later\\n'); process.stderr.write('stderr failure\\n'); process.stdout.write('TAIL\\n'); process.exitCode=7;`;
  assert.equal(await runCodexOutput(node(code), f.io, f.options), 7);
  assert.match(f.out(), /HEAD/); assert.match(f.out(), /TAIL/); assert.match(f.out(), /ERROR middle/);
  assert.match(f.err(), /stderr failure/); assert.ok(f.out().length < 50000);
  const [log] = await logs(f);
  assert.ok(log.text.length > 10 * 1024 * 1024); assert.match(log.text, /stderr failure/);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(log.path)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(log.path))).mode & 0o777, 0o700);
  }
  const rows = (await fs.readFile(path.join(f.home, '.nexakit/ahorro.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['agent','antes','despues','fecha','lineasAntes','lineasDespues'].sort());
  assert.equal(rows[0].agent, 'codex'); assert.ok(rows[0].antes > rows[0].despues); assert.ok(rows[0].lineasAntes >= rows[0].lineasDespues);
});
test('literal arguments, cwd, env, stdin, and distinct stderr', async t => {
  const f = await fixture(t); const arg = '$(touch owned); & | `echo secret`';
  f.io.input = Readable.from(['input text']);
  assert.equal(await runCodexOutput([...node(`let x='';process.stdin.on('data',c=>x+=c);process.stdin.on('end',()=>{console.log(JSON.stringify([process.argv[1],process.cwd(),process.env.ONLY,x]));console.error('problem');});`), arg], f.io, { ...f.options, projectRoot: f.home, env: { ONLY: 'yes' } }), 0);
  assert.deepEqual(JSON.parse(f.out()), [arg, f.home, 'yes', 'input text']); assert.equal(f.err(), 'problem\n');
  assert.equal((await logs(f))[0].text.includes(arg), true);
  await assert.rejects(fs.stat(path.join(f.home, '.nexakit/ahorro.jsonl')), { code: 'ENOENT' });
});
test('full bypass preserves every byte and produces no savings record', async t => {
  const f = await fixture(t); const expected = 'á'.repeat(20000) + '\n';
  assert.equal(await runCodexOutput(node(`process.stdout.write('á'.repeat(20000)+'\\n');process.stderr.write('err');`), f.io, { ...f.options, env: { NEXAKIT_SALIDA: 'completa' } }), 0);
  assert.equal(f.out(), expected); assert.equal(f.err(), 'err'); assert.equal((await logs(f))[0].text.length, expected.length + 3);
  await assert.rejects(fs.stat(path.join(f.home, '.nexakit/ahorro.jsonl')), { code: 'ENOENT' });
});
test('ENOENT returns 127 and signals return 128 + signal number', async t => {
  const f = await fixture(t);
  assert.equal(await runCodexOutput(['nexakit-command-does-not-exist'], f.io, f.options), 127); assert.match(f.err(), /ENOENT/);
  if (process.platform !== 'win32') assert.equal(await runCodexOutput(node(`process.kill(process.pid,'SIGTERM')`), f.io, f.options), 143);
});
test('rejects symlink directories and runs once with complete fallback output', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const target = path.join(f.home, 'outside'); await fs.mkdir(target);
  await fs.symlink(target, path.join(f.home, '.nexakit'));
  assert.equal(await runCodexOutput(node(`require('fs').appendFileSync('runs','1');process.stdout.write('x'.repeat(20000));process.stderr.write('failure');process.exitCode=7`), f.io, { ...f.options, projectRoot: f.home }), 7);
  assert.equal(await fs.readFile(path.join(f.home, 'runs'), 'utf8'), '1'); assert.equal(f.out(), 'x'.repeat(20000)); assert.match(f.err(), /failure/); assert.match(f.err(), /guardar/i); assert.deepEqual(await fs.readdir(target), []);
});
test('does not follow a symlink savings file', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.home, '.nexakit')); const target = path.join(f.home, 'target'); await fs.writeFile(target, 'untouched');
  await fs.symlink(target, path.join(f.home, '.nexakit/ahorro.jsonl'));
  assert.equal(await runCodexOutput(node(`console.log('abc\\n'.repeat(300))`), f.io, f.options), 0);
  assert.equal(await fs.readFile(target, 'utf8'), 'untouched'); assert.match(f.err(), /registro/i);
});
test('a huge single line retains late failure text with bounded memory/output', async t => {
  const f = await fixture(t);
  assert.equal(await runCodexOutput(node(`for(let i=0;i<12000;i++)process.stdout.write('z'.repeat(1024));process.stdout.write(' ERROR late failure');`), f.io, f.options), 0);
  assert.ok(f.out().length < 50000); assert.match(f.out(), /ERROR late failure/);
});

test('function sinks preserve short stderr and handle full output and input strings', async t => {
  const f = await fixture(t); let out = '', err = '';
  const io = { out: x => { out += x; }, err: x => { err += x; }, input: 'hello' };
  assert.equal(await runCodexOutput(node(`process.stdin.pipe(process.stdout);process.stderr.write('short error');`), io, f.options), 0);
  assert.equal(out, 'hello'); assert.equal(err, 'short error');
  out = ''; err = '';
  assert.equal(await runCodexOutput(node(`process.stdout.write('á'.repeat(20000));process.stderr.write('err');`), io, { ...f.options, env: { NEXAKIT_SALIDA: 'completa' } }), 0);
  assert.equal(out, 'á'.repeat(20000)); assert.equal(err, 'err');
});

test('function sinks decode UTF-8 split across chunks in full mode', async t => {
  const f = await fixture(t); let output = '';
  assert.equal(await runCodexOutput(node(`process.stdout.write(Buffer.from([0xc3]));setTimeout(()=>process.stdout.write(Buffer.from([0xa1])),40);`), { out: x => { output += x; }, err: () => {} }, { ...f.options, env: { NEXAKIT_SALIDA: 'completa' } }), 0);
  assert.equal(output, 'á');
});

test('ahorro --json recognizes Codex savings records', async t => {
  const f = await fixture(t);
  assert.equal(await runCodexOutput(node(`console.log('hello\\n'.repeat(1000))`), f.io, f.options), 0);
  let report = '';
  assert.equal(await runAhorroCommand(['--json'], { out: x => { report += x; }, err: () => {} }, f.options), 0);
  assert.equal(JSON.parse(report).total.recortes, 1);
  assert.equal(JSON.parse(report).ultimos7Dias.recortes, 1);
  assert.ok(JSON.parse(report).total.caracteresEvitados > 0);
});

test('midstream disk failure replays the prefix and executes only once', async t => {
  const f = await fixture(t); const original = fsSync.writeSync; let writes = 0;
  const mock = t.mock.method(fsSync, 'writeSync', (...args) => {
    if (++writes === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return original(...args);
  });
  try {
    assert.equal(await runCodexOutput(node(`require('fs').appendFileSync('runs','1');process.stdout.write('prefix');setTimeout(()=>{process.stdout.write('rest');process.stderr.write('failure');process.exitCode=7},40)`), f.io, { ...f.options, projectRoot: f.home }), 7);
  } finally { mock.mock.restore(); }
  assert.equal(f.out(), 'prefixrest'); assert.match(f.err(), /failure/); assert.match(f.err(), /guardar/);
  assert.equal(await fs.readFile(path.join(f.home, 'runs'), 'utf8'), '1');
});

test('128MiB output fits a 24MiB heap and emits a bounded summary', async t => {
  const f = await fixture(t);
  const producer = `for(let i=0;i<131072;i++)process.stdout.write('x'.repeat(1023)+'\\n');`;
  const source = `import {runCodexOutput} from ${JSON.stringify(new URL('../src/codex-output.js', import.meta.url).href)};
    let length=0; const code=await runCodexOutput([process.execPath,'-e',${JSON.stringify(producer)}], {out:x=>{length+=x.length},err:x=>{length+=x.length}}, ${JSON.stringify(f.options)});
    console.log(JSON.stringify({code,length}));`;
  const child = spawnSync(process.execPath, ['--max-old-space-size=24', '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout);
  assert.equal(result.code, 0); assert.ok(result.length < 50000);
  const folder = path.join(f.home, '.nexakit/salidas');
  assert.equal((await fs.stat(path.join(folder, (await fs.readdir(folder))[0]))).size, 128 * 1024 * 1024);
});

test('does not lose earlier stderr if writing and replaying the log both fail', async t => {
  const f = await fixture(t); const original = fsSync.writeSync; let writes = 0;
  const writeMock = t.mock.method(fsSync, 'writeSync', (...args) => {
    if (++writes === 2) throw new Error('disk failed');
    return original(...args);
  });
  const readMock = t.mock.method(fsSync, 'readSync', () => { throw new Error('read failed'); });
  try {
    assert.equal(await runCodexOutput(node(`process.stderr.write('earlier error');setTimeout(()=>{process.stdout.write('later');process.exitCode=7},40);`), f.io, f.options), 7);
  } finally { writeMock.mock.restore(); readMock.mock.restore(); }
  assert.match(f.err(), /earlier error/); assert.match(f.out(), /later/);
});
