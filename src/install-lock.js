import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const LOCK_FILE = 'bloqueo';
const MAX_RECOVERIES = 10;

export class LockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LockError';
    this.code = code;
  }
}

export function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ignoreMissing = error => { if (error.code !== 'ENOENT') throw error; };

// The state is `missing`, `unreadable` (not valid JSON, wrong shape or not a regular file) or `ok`.
async function readOwner(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (error) {
    return error.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' };
  }
  try {
    const data = JSON.parse(text);
    if (Number.isInteger(data?.pid) && data.pid > 0 && typeof data.equipo === 'string' && typeof data.marca === 'string') {
      return { state: 'ok', owner: data };
    }
  } catch { /* falls through */ }
  return { state: 'unreadable' };
}

// Writes the record to a private file and hard-links it into place: the lock never exists half written.
async function createExclusive(file, record) {
  const temporary = `${file}.nuevo-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  try {
    await fs.link(temporary, file);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

// Called only for an owner judged dead. Renaming is the step only one process can win.
async function recover(file, judgedMark) {
  const again = await readOwner(file);
  if (again.state !== 'ok' || again.owner.marca !== judgedMark) return;
  const moved = `${file}.abandonado.${crypto.randomUUID()}`;
  try { await fs.rename(file, moved); } catch (error) { return ignoreMissing(error); }
  const taken = await readOwner(moved);
  if (!(taken.state === 'ok' && taken.owner.marca === judgedMark)) {
    // Another run replaced the lock between the check and the rename: put its lock back if the name is free.
    try { await fs.link(moved, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  await fs.unlink(moved).catch(() => {});
}

const busy = (file, unreadable) => new LockError('ocupado', unreadable
  ? `No se puede leer el bloqueo de nexakit. Si no hay ninguna instalación en curso, bórralo a mano: ${file}`
  : 'Otra instalación de nexakit está en curso; vuelve a intentarlo cuando termine.');

export async function acquireLock(nexakitDir, {
  waitMs = 30_000, pollMs = 250, hostname = os.hostname(), pid = process.pid, isAlive = defaultIsAlive
} = {}) {
  await fs.mkdir(nexakitDir, { recursive: true, mode: 0o700 });
  const file = path.join(nexakitDir, LOCK_FILE);
  const token = crypto.randomUUID();
  const record = { pid, equipo: hostname, hora: new Date().toISOString(), marca: token };
  const deadline = Date.now() + waitMs;
  let recoveries = 0;

  while (true) {
    if (await createExclusive(file, record)) return heldLock(file, token);

    const current = await readOwner(file);
    if (current.state === 'missing') continue;
    if (current.state === 'ok') {
      const { owner } = current;
      if (owner.equipo !== hostname) {
        throw new LockError('otro-equipo', `El bloqueo de nexakit lo creó otro equipo (${owner.equipo}). Si no hay ninguna instalación en curso, bórralo a mano: ${file}`);
      }
      // Age never decides: a live owner keeps the lock however long it takes.
      if (!isAlive(owner.pid)) {
        if (++recoveries > MAX_RECOVERIES) throw busy(file, false);
        await recover(file, owner.marca);
        continue;
      }
    }
    if (Date.now() >= deadline) throw busy(file, current.state === 'unreadable');
    await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
  }
}

function heldLock(file, token) {
  return {
    token,
    async assertHeld() {
      const current = await readOwner(file);
      if (!(current.state === 'ok' && current.owner.marca === token)) {
        throw new LockError('perdido', 'Se perdió el bloqueo de nexakit; no se escribió nada más.');
      }
    },
    async release() {
      const current = await readOwner(file);
      if (current.state === 'ok' && current.owner.marca === token) await fs.unlink(file).catch(ignoreMissing);
    }
  };
}
