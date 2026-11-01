import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const moduleUrl = new URL('../src/install-lock.js', import.meta.url);
const fast = { waitMs: 50, pollMs: 5 };
const exists = file => fs.access(file).then(() => true, () => false);

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'install-lock-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, '.nexakit');
  await fs.mkdir(dir);
  const file = path.join(dir, 'bloqueo');
  return {
    root, dir, file,
    write: data => fs.writeFile(file, JSON.stringify({ pid: 9999, equipo: os.hostname(), hora: new Date().toISOString(), marca: 'ajena', ...data })),
    read: async () => JSON.parse(await fs.readFile(file, 'utf8'))
  };
}

test('acquires, records its owner, releases and leaves nothing behind', async t => {
  const f = await fixture(t), { acquireLock } = await import(moduleUrl);
  const lock = await acquireLock(f.dir, { ...fast, pid: 1234 });
  const data = await f.read();
  assert.equal(data.pid, 1234);
  assert.equal(data.equipo, os.hostname());
  assert.equal(data.marca, lock.token);
  assert.equal(typeof data.hora, 'string');
  await lock.assertHeld();
  await lock.release();
  await lock.release();
  assert.deepEqual(await fs.readdir(f.dir), []);
});

test('creates the folder when it does not exist yet', async t => {
  const f = await fixture(t), { acquireLock } = await import(moduleUrl);
  const dir = path.join(f.root, 'nuevo', '.nexakit');
  const lock = await acquireLock(dir, fast);
  assert.equal(await exists(path.join(dir, 'bloqueo')), true);
  await lock.release();
});

test('a live owner keeps the lock however old it is, and the waiter reports busy', async t => {
  const f = await fixture(t), { acquireLock } = await import(moduleUrl);
  await f.write({ hora: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
  const before = await fs.readFile(f.file, 'utf8');
  await assert.rejects(acquireLock(f.dir, { ...fast, isAlive: () => true }), { code: 'ocupado' });
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  assert.deepEqual(await fs.readdir(f.dir), ['bloqueo']);
});

test('recovers the lock of a dead owner and cleans up after itself', async t => {
  const f = await fixture(t), { acquireLock } = await import(moduleUrl);
  await f.write({ pid: 9999 });
  const lock = await acquireLock(f.dir, { ...fast, pid: 1111, isAlive: pid => pid !== 9999 });
  assert.equal((await f.read()).marca, lock.token);
  assert.deepEqual(await fs.readdir(f.dir), ['bloqueo']);
});

test('never recovers the lock of another host, even if its process looks dead', async t => {
  const f = await fixture(t), { acquireLock } = await import(moduleUrl);
  await f.write({ equipo: 'otro-equipo-xyz' });
  const before = await fs.readFile(f.file, 'utf8');
  await assert.rejects(acquireLock(f.dir, { ...fast, isAlive: () => false }),
    error => error.code === 'otro-equipo' && error.message.includes(f.file));
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
});

test('an unreadable lock file is not taken over; the error says where it is', async t => {
  const f = await fixture(t), { acquireLock } = await import(moduleUrl);
  await fs.writeFile(f.file, 'esto no es json');
  await assert.rejects(acquireLock(f.dir, { ...fast, isAlive: () => false }),
    error => error.code === 'ocupado' && error.message.includes(f.file));
  assert.equal(await fs.readFile(f.file, 'utf8'), 'esto no es json');
});

test('release only removes its own lock', async t => {
  const f = await fixture(t), { acquireLock } = await import(moduleUrl);
  const lock = await acquireLock(f.dir, fast);
  await f.write({ marca: 'de-otra-ejecucion' });
  await lock.release();
  assert.equal((await f.read()).marca, 'de-otra-ejecucion');
});

test('assertHeld fails once the lock was replaced or removed', async t => {
  const f = await fixture(t), { acquireLock } = await import(moduleUrl);
  const lock = await acquireLock(f.dir, fast);
  await f.write({ marca: 'de-otra-ejecucion' });
  await assert.rejects(lock.assertHeld(), { code: 'perdido' });
  await fs.rm(f.file);
  await assert.rejects(lock.assertHeld(), { code: 'perdido' });
});

test('two runs recovering the same dead lock end with exactly one owner', async t => {
  const f = await fixture(t), { acquireLock } = await import(moduleUrl);
  await f.write({ pid: 9999 });
  const isAlive = pid => pid !== 9999;
  const results = await Promise.allSettled([
    acquireLock(f.dir, { ...fast, pid: 1111, isAlive }),
    acquireLock(f.dir, { ...fast, pid: 2222, isAlive })
  ]);
  const won = results.filter(result => result.status === 'fulfilled');
  const lost = results.filter(result => result.status === 'rejected');
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason.code, 'ocupado');
  assert.equal((await f.read()).marca, won[0].value.token);
  await won[0].value.assertHeld();
  assert.deepEqual(await fs.readdir(f.dir), ['bloqueo']);
});
