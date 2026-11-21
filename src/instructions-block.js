import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
// Auxiliares comunes de los bloques que nexakit escribe en CLAUDE.md, AGENTS.md y GEMINI.md.
export const hash = (text) => createHash('sha256').update(text).digest('hex');
export const NAMES = { claude: 'CLAUDE.md', codex: 'AGENTS.md', antigravity: 'GEMINI.md' };
export function targets({ homeDirectory, environment = {}, codexHome, agents = Object.keys(NAMES) }) {
  if (!homeDirectory || !path.isAbsolute(homeDirectory))
    throw new Error('Se requiere homeDirectory absoluto.');
  const folders = {
    claude: path.join(homeDirectory, '.claude'),
    codex: codexHome ?? environment.CODEX_HOME ?? path.join(homeDirectory, '.codex'),
    antigravity: path.join(homeDirectory, '.gemini'),
  };
  return agents
    .filter((client) => NAMES[client])
    .map((client) => ({ client, name: NAMES[client], target: path.join(folders[client], NAMES[client]) }));
}
export async function readText(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error('Archivo de instrucciones o registro en conflicto.');
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function checkParent(directory, create = false) {
  const info = await fs.lstat(directory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info && (!info.isDirectory() || info.isSymbolicLink()))
    throw new Error('La carpeta de instrucciones o registro no es normal.');
  if (!info && create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
}
export async function proof(file) {
  await checkParent(path.dirname(file));
  const text = await readText(file);
  if (text === null) return {};
  const records = JSON.parse(text);
  if (!records || typeof records !== 'object' || Array.isArray(records))
    throw new Error('Registro de instrucciones inválido.');
  return records;
}
export function blockOf(text, START, END) {
  const a = text?.indexOf(START) ?? -1,
    b = text?.indexOf(END) ?? -1;
  if (a < 0 || b <= a || text.indexOf(START, a + START.length) >= 0 || text.indexOf(END, b + END.length) >= 0)
    return null;
  return text.slice(a, b + END.length);
}
export async function writeAtomic(target, text, lock) {
  await lock.assertHeld();
  const stat = await fs.lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const tmp = target + '.' + randomUUID();
  await fs.writeFile(tmp, text, { flag: 'wx', mode: stat?.mode ?? 0o600 });
  try {
    await lock.assertHeld();
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
