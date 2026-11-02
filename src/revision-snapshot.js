import fs from 'node:fs/promises';
import path from 'node:path';

// Observe names and metadata, including ignored files, without following links.
export async function snapshotRevision(root) {
  const entries = new Map();
  async function walk(directory, prefix = '') {
    for (const name of (await fs.readdir(directory)).sort()) {
      if (name === '.git' || name === 'node_modules') continue;
      const full = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) {
        entries.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs, kind: 'symlink' });
      } else if (stat.isDirectory()) {
        await walk(full, relative);
      } else {
        entries.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs, kind: stat.isFile() ? 'file' : 'other' });
      }
    }
  }
  await walk(root);
  return entries;
}

export function compareRevisionSnapshots(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(name => {
    const a = before.get(name), b = after.get(name);
    return !a || !b || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.kind !== b.kind;
  }).sort();
}
