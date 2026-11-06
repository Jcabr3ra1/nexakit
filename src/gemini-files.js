import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
const TYPES = new Set(['.txt','.md','.csv','.tsv','.json','.yaml','.yml','.js','.ts','.py','.html','.css','.xml',
  '.png','.jpg','.jpeg','.webp','.gif','.pdf','.wav','.mp3','.m4a','.aiff','.ogg','.flac','.mp4','.mov','.webm','.avi']);
export async function readRegular(file, limit = 20 * 1024 * 1024) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw new Error('Archivo inválido o demasiado grande.');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw Object.assign(new Error('El archivo cambió.'), { code: 'EFILECHANGED' });
    const bytes = Buffer.alloc(opened.size); let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, Math.min(65536, bytes.length-offset), offset);
      if (!bytesRead) throw Object.assign(new Error('Lectura incompleta.'), { code: 'EFILECHANGED' }); offset += bytesRead;
    }
    const after = await handle.stat();
    const named = await fs.lstat(file);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.ino !== opened.ino || named.dev !== opened.dev ||
        after.nlink !== 1 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw Object.assign(new Error('El archivo cambió.'), { code: 'EFILECHANGED' });
    return bytes;
  } finally { await handle.close(); }
}
export async function selectedInputs(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 8 || new Set(files).size !== files.length) throw new Error('Elige entre 1 y 8 archivos distintos.');
  const inputs = []; let size = 0;
  for (const file of files) {
    if (typeof file !== 'string' || !file || !TYPES.has(path.extname(file).toLowerCase())) throw new Error('Formato de entrada no admitido.');
    const bytes = await readRegular(file); size += bytes.length;
    if (size > 32 * 1024 * 1024) throw new Error('Los archivos superan 32 MiB.');
    inputs.push({ name: `input-${inputs.length+1}${path.extname(file).toLowerCase()}`, bytes });
  }
  return inputs;
}
export async function ownRun(directory, root, kinds) {
  const canonical = await fs.realpath(root), absolute = path.resolve(directory);
  const relative = path.relative(canonical, absolute), parts = relative.split(path.sep);
  if (parts.length !== 2 || !kinds.includes(parts[0]) || !parts[1] || parts[1] === '..') throw new Error('Directorio ajeno.');
  for (const candidate of [path.dirname(absolute), absolute]) {
    const info = await fs.lstat(candidate);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Directorio inválido.');
  }
  return absolute;
}
