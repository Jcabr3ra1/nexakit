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

// Called only for an owner judged dead. The removal happens under a second, short-lived guard, so two
// recoverers can never act at once: otherwise one could remove a lock another process had just taken.
// Under the guard only the dead lock can be at `file`: acquirers create it only when it is absent, and its
// dead owner will not release it. Returns 'recuperado', or 'ocupado' when someone else is recovering it.
async function recover(file, judgedMark, { record, hostname, isAlive }) {
  const guard = `${file}.recuperando`;
  if (!(await createExclusive(guard, record))) {
    const holder = await readOwner(guard);
    if (holder.state === 'ok' && holder.owner.equipo === hostname && !isAlive(holder.owner.pid)) {
      // A recoverer died mid-recovery. Its guard is removed only if it is still the one judged dead.
      const again = await readOwner(guard);
      if (again.state === 'ok' && again.owner.marca === holder.owner.marca) await fs.unlink(guard).catch(ignoreMissing);
      return 'recuperado';
    }
    return 'ocupado';
  }
  try {
    const again = await readOwner(file);
    if (again.state === 'ok' && again.owner.marca === judgedMark) await fs.unlink(file).catch(ignoreMissing);
    return 'recuperado';
  } finally {
    const current = await readOwner(guard);
    if (current.state === 'ok' && current.owner.marca === record.marca) await fs.unlink(guard).catch(ignoreMissing);
  }
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
      if (!isAlive(owner.pid) && await recover(file, owner.marca, { record, hostname, isAlive }) === 'recuperado') {
        if (++recoveries > MAX_RECOVERIES) throw busy(file, false);
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
