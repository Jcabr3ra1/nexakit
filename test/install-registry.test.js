import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const moduleUrl = new URL('../src/install-registry.js', import.meta.url);
const lockUrl = new URL('../src/install-lock.js', import.meta.url);
const held = { assertHeld: async () => {} };
const lost = { assertHeld: async () => { throw Object.assign(new Error('perdido'), { code: 'perdido' }); } };

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'install-registry-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, '.nexakit');
  await fs.mkdir(dir);
  return { root, dir, file: path.join(dir, 'instalaciones.json') };
}
const entry = (name, extra = {}) => ({ destino: `/home/.claude/skills/${name}`, apunta: `/old/skills/${name}`, raiz: '/old', ...extra });

test('an absent registry reads as empty and reading never creates it', async t => {
  const f = await fixture(t), { readRegistry, isRegistered } = await import(moduleUrl);
  const registry = await readRegistry(f.dir);
  assert.deepEqual(registry, { version: 1, entradas: [] });
  assert.equal(isRegistered(registry, '/home/.claude/skills/a', '/old/skills/a'), false);
  assert.deepEqual(await fs.readdir(f.dir), []);
  assert.deepEqual(await readRegistry(path.join(f.root, 'no-existe')), { version: 1, entradas: [] });
});

test('records entries, upserts by destination and matches the exact literal', async t => {
  const f = await fixture(t), { readRegistry, recordEntries, isRegistered } = await import(moduleUrl);
  await recordEntries(f.dir, [entry('a'), entry('b')], held);
  let registry = await readRegistry(f.dir);
  assert.equal(registry.entradas.length, 2);
  assert.match(registry.entradas[0].fecha, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.equal(isRegistered(registry, '/home/.claude/skills/a', '/old/skills/a'), true);
  assert.equal(isRegistered(registry, '/home/.claude/skills/a', '/other/skills/a'), false);
  assert.equal(isRegistered(registry, '/home/.claude/skills/z', '/old/skills/a'), false);

  await recordEntries(f.dir, [entry('a', { apunta: '/new/skills/a', raiz: '/new' })], held);
  registry = await readRegistry(f.dir);
  assert.equal(registry.entradas.length, 2);
  assert.equal(registry.entradas[0].destino, '/home/.claude/skills/a', 'the entry keeps its position');
  assert.equal(registry.entradas[0].raiz, '/new');
  assert.equal(isRegistered(registry, '/home/.claude/skills/a', '/old/skills/a'), false);
  assert.equal(isRegistered(registry, '/home/.claude/skills/a', '/new/skills/a'), true);

  await recordEntries(f.dir, [entry('c'), entry('c', { apunta: '/x/skills/c' })], held);
  registry = await readRegistry(f.dir);
  assert.equal(registry.entradas.filter(item => item.destino.endsWith('/c')).length, 1);
  assert.equal(registry.entradas.find(item => item.destino.endsWith('/c')).apunta, '/x/skills/c');

  await recordEntries(f.dir, [], held);
  assert.deepEqual(await fs.readdir(f.dir), ['instalaciones.json'], 'no temporary files are left behind');
  if (process.platform !== 'win32') assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
});

test('refuses to write when the lock is not held, and changes nothing', async t => {
  const f = await fixture(t), { recordEntries } = await import(moduleUrl);
  await assert.rejects(recordEntries(f.dir, [entry('a')], lost), { code: 'perdido' });
  assert.deepEqual(await fs.readdir(f.dir), []);

  await recordEntries(f.dir, [entry('a')], held);
  const before = await fs.readFile(f.file, 'utf8');
  await assert.rejects(recordEntries(f.dir, [entry('b')], lost), { code: 'perdido' });
  assert.equal(await fs.readFile(f.file, 'utf8'), before);

  // The lock is checked again right before the write, so losing it mid-way also changes nothing.
  let calls = 0;
  const losesLater = { assertHeld: async () => { if (++calls > 1) throw Object.assign(new Error('perdido'), { code: 'perdido' }); } };
  await assert.rejects(recordEntries(f.dir, [entry('c')], losesLater), { code: 'perdido' });
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  assert.deepEqual(await fs.readdir(f.dir), ['instalaciones.json']);
});

test('works under a real lock and fails once that lock was replaced', async t => {
  const f = await fixture(t), { recordEntries } = await import(moduleUrl), { acquireLock } = await import(lockUrl);
  const lock = await acquireLock(f.dir, { waitMs: 50, pollMs: 5 });
  await recordEntries(f.dir, [entry('a')], lock);
  await fs.writeFile(path.join(f.dir, 'bloqueo'), JSON.stringify({ pid: 4242, equipo: os.hostname(), hora: new Date().toISOString(), marca: 'otra' }));
  await assert.rejects(recordEntries(f.dir, [entry('b')], lock), { code: 'perdido' });
  await lock.release();
});

test('a damaged registry is reported with its path and never overwritten', async t => {
  const f = await fixture(t), { readRegistry, recordEntries } = await import(moduleUrl);
  const damaged = error => /dañado/u.test(error.message) && error.message.includes(f.file);
  const cases = [
    'esto no es json',
    JSON.stringify({ version: 2, entradas: [] }),
    JSON.stringify({ version: 1, entradas: 'x' }),
    JSON.stringify({ version: 1, entradas: [{ destino: 1, apunta: 'a', raiz: 'b', fecha: 'c' }] }),
    JSON.stringify({ version: 1, entradas: [{ destino: 'a', apunta: 'b', raiz: 'c' }] })
  ];
  for (const content of cases) {
    await fs.writeFile(f.file, content);
    await assert.rejects(readRegistry(f.dir), damaged);
    await assert.rejects(recordEntries(f.dir, [entry('a')], held), damaged);
    assert.equal(await fs.readFile(f.file, 'utf8'), content);
    assert.deepEqual(await fs.readdir(f.dir), ['instalaciones.json']);
  }
  await fs.rm(f.file);

  await fs.mkdir(f.file);
  await assert.rejects(readRegistry(f.dir), damaged);
  await fs.rmdir(f.file);

  await fs.writeFile(path.join(f.root, 'otro.json'), '{"version":1,"entradas":[]}');
  await fs.symlink(path.join(f.root, 'otro.json'), f.file);
  await assert.rejects(readRegistry(f.dir), damaged);
  await assert.rejects(recordEntries(f.dir, [entry('a')], held), damaged);
});

test('rejects malformed entries before touching the file', async t => {
  const f = await fixture(t), { recordEntries } = await import(moduleUrl);
  await assert.rejects(recordEntries(f.dir, [{ destino: '', apunta: 'x', raiz: 'y' }], held), /no válida/u);
  await assert.rejects(recordEntries(f.dir, [{ destino: 'x', apunta: 'y' }], held), /no válida/u);
  await assert.rejects(recordEntries(f.dir, 'no es una lista', held), /no válida/u);
  assert.deepEqual(await fs.readdir(f.dir), []);
});
