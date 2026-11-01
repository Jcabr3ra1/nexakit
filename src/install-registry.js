import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const REGISTRY_FILE = 'instalaciones.json';
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const FIELDS = ['destino', 'apunta', 'raiz', 'fecha'];

const damaged = file => new Error(`El registro de instalaciones de nexakit está dañado: ${file}`);
const isText = value => typeof value === 'string' && value.length > 0;
const empty = () => ({ version: 1, entradas: [] });

// The registry is the only proof that a broken link belongs to nexakit. `apunta` must be what `readlink`
// returns for the link, since that is the value compared later.
export async function readRegistry(nexakitDir) {
  const file = path.join(nexakitDir, REGISTRY_FILE);
  let info;
  try { info = await fs.lstat(file); } catch (error) {
    if (error.code === 'ENOENT') return empty();
    throw error;
  }
  if (!info.isFile() || info.size > MAX_REGISTRY_BYTES) throw damaged(file);
  let data;
  try { data = JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw damaged(file); }
  const valid = data?.version === 1 && Array.isArray(data.entradas) &&
    data.entradas.every(entry => entry && typeof entry === 'object' && FIELDS.every(field => isText(entry[field])));
  if (!valid) throw damaged(file);
  return {
    version: 1,
    entradas: data.entradas.map(({ destino, apunta, raiz, fecha }) => ({ destino, apunta, raiz, fecha }))
  };
}

export const isRegistered = (registry, target, literal) =>
  registry.entradas.some(entry => entry.destino === target && entry.apunta === literal);

// Must run under the install lock: the lock is checked on entry and again right before the file is replaced.
export async function recordEntries(nexakitDir, entries, lock) {
  if (!Array.isArray(entries) || !entries.every(entry => isText(entry?.destino) && isText(entry?.apunta) && isText(entry?.raiz))) {
    throw new Error('Entrada del registro de instalaciones no válida.');
  }
  if (entries.length === 0) return;
  await lock.assertHeld();

  const registry = await readRegistry(nexakitDir);
  const fecha = new Date().toISOString();
  // A Map keeps the position of an entry that is replaced.
  const byTarget = new Map(registry.entradas.map(entry => [entry.destino, entry]));
  for (const { destino, apunta, raiz } of entries) byTarget.set(destino, { destino, apunta, raiz, fecha });

  const file = path.join(nexakitDir, REGISTRY_FILE);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ version: 1, entradas: [...byTarget.values()] }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await lock.assertHeld();
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}
