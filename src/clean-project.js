import fs from 'node:fs/promises';
import path from 'node:path';
import { gitTopLevel, runGit as defaultRunGit } from './project-root.js';

const ignoredEntries = new Set(['.git', '.DS_Store', 'Thumbs.db']);
export async function inspectFolder(dir, { runGit = defaultRunGit } = {}) {
  const root = await fs.realpath(dir);
  const entries = (await fs.readdir(root)).sort();
  return { empty: entries.every(name => ignoredEntries.has(name)), insideGit: Boolean(await gitTopLevel(root, runGit)), entries };
}
export function projectName(dir) {
  const normalized = path.basename(dir).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 214).replace(/-+$/g, '');
  return normalized || 'proyecto';
}
