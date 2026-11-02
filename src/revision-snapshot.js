import fs from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const digest = value => createHash('sha256').update(value).digest('hex');
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
async function gitSnapshot(root, entries) {
  let top;
  try { top = git(root, ['rev-parse', '--show-toplevel']).trim(); } catch { return; }
  if (await fs.realpath(top) !== await fs.realpath(root)) return;
  const put = (name, content) => entries.set(`.git/${name}`, { kind: 'git', sha256: digest(content) });
  let commit;
  try { commit = git(root, ['rev-parse', '--verify', 'HEAD']); } catch { commit = 'unborn'; }
  let symbolic;
  try { symbolic = git(root, ['symbolic-ref', '-q', 'HEAD']); } catch { symbolic = 'detached'; }
  put('HEAD', symbolic + commit);
  put('status', git(root, ['status', '--porcelain=v1', '--ignored', '-z', '--untracked-files=all']));
  put('refs', git(root, ['for-each-ref', '--format=%(refname) %(objectname) %(symref)']));
  const index = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']).trim());
  try { put('index', await fs.readFile(index)); } catch (error) { if (error.code !== 'ENOENT') throw error; put('index', 'absent'); }
}

// Hash files, observe dependency directory entries, and pin Git state without following links.
export async function snapshotRevision(root) {
  const entries = new Map();
  async function walk(directory, prefix = '') {
    for (const name of (await fs.readdir(directory)).sort()) {
      if (name === '.git') continue;
      const full = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) {
        entries.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs, kind: 'symlink', sha256: digest(await fs.readlink(full)) });
      } else if (stat.isDirectory()) {
        if (name === 'node_modules') {
          for (const child of (await fs.readdir(full)).sort()) {
            const info = await fs.lstat(path.join(full, child));
            entries.set(`${relative}/${child}`, { size: info.size, kind: info.isDirectory() ? 'dependency-directory' : 'dependency-entry' });
          }
        } else await walk(full, relative);
      } else {
        const value = { size: stat.size, mtimeMs: stat.mtimeMs, kind: stat.isFile() ? 'file' : 'other' };
        if (stat.isFile()) {
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(full, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) })) hash.update(chunk);
          value.sha256 = hash.digest('hex');
        }
        entries.set(relative, value);
      }
    }
  }
  await walk(root);
  await gitSnapshot(root, entries);
  return entries;
}

export function compareRevisionSnapshots(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(name => {
    const a = before.get(name), b = after.get(name);
    return !a || !b || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.kind !== b.kind || a.sha256 !== b.sha256;
  }).sort();
}
