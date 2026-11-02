import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SkillCatalogError } from './skill-catalog.js';

export function hashSkillFiles(files) {
  return files
    .map(file => ({ path: file.path, sha256: createHash('sha256').update(file.bytes).digest('hex') }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

// The one safe walk of a skill folder: no links, only regular files, bounded size. Never executes anything.
export async function readSkillFiles(root, label) {
  if (!(await fs.lstat(root)).isDirectory()) throw new SkillCatalogError(`No es una carpeta de skill: ${label}.`);
  const files = [];
  let totalBytes = 0;
  async function visit(dir, prefix = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (rel.length > 200 || rel.split('/').length > 32) throw new SkillCatalogError(`Ruta demasiado larga en ${label}.`);
      const full = path.join(dir, entry.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) throw new SkillCatalogError(`Enlace no admitido en ${label}/${rel}.`);
      if (stat.isDirectory()) await visit(full, rel);
      else if (stat.isFile()) {
        if (files.length >= 256 || stat.size > 512 * 1024 || totalBytes + stat.size > 64 * 1024 * 1024) {
          throw new SkillCatalogError(`Límite de archivos o tamaño excedido en ${label}.`);
        }
        const bytes = await fs.readFile(full);
        totalBytes += bytes.length;
        files.push({ path: rel, bytes });
      } else throw new SkillCatalogError(`Archivo no regular en ${label}/${rel}.`);
    }
  }
  await visit(root);
  if (!files.some(file => file.path === 'SKILL.md')) throw new SkillCatalogError(`Falta SKILL.md en ${label}.`);
  return files;
}
