// Decides which folder is "the project": the whole Git repository, even when nexakit runs from a subfolder, so
// one memory and one skill install serve the whole repository. Read-only: it only asks Git and reads paths.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Same rule the memory uses for its id (src/init.js).
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const FALLBACK_ID = 'proyecto';

export const runGit = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

export function projectIdentity(root) {
  const name = path.basename(root);
  const id = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
  const valid = PROJECT_ID_PATTERN.test(id) && id.length >= 2 && id.length <= 64;
  return { id: valid ? id : FALLBACK_ID, displayName: name.replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim() || name };
}

const realpathOrNull = target => fs.realpath(target).catch(() => null);

// Any Git failure (not installed, not a repository, dubious ownership) means "no Git": detection never breaks on it.
export async function gitTopLevel(startedIn, run) {
  try {
    const output = String(run(['rev-parse', '--show-toplevel'], startedIn) ?? '').trim();
    return output ? await realpathOrNull(output) : null;
  } catch {
    return null;
  }
}

async function cleanBoundary(start, topLevel) {
  let current = start;
  while (true) {
    try {
      const dir=await fs.lstat(path.join(current,'.agent-toolkit'));
      if(dir.isDirectory() && !dir.isSymbolicLink()) {
        const file=path.join(current,'.agent-toolkit/manifest.json'),stat=await fs.lstat(file);
        if(stat.isFile() && !stat.isSymbolicLink() && stat.nlink===1 && stat.size<=128000) {
          const data=JSON.parse(await fs.readFile(file,'utf8'));
          if(data.managedBy==='nexakit' && ['confirmado','creado','fallido'].includes(data.answers?.cleanProject?.status)) return current;
        }
      }
    } catch { /* Only an owned readable marker establishes a boundary. */ }
    if(current===topLevel || path.dirname(current)===current) return null;
    current=path.dirname(current);
  }
}

export async function resolveProjectRoot(start, { homeDirectory = os.homedir(), runGit: run = runGit } = {}) {
  const startedIn = await fs.realpath(start);
  const topLevel = await gitTopLevel(startedIn, run);
  // A repository at the home folder (dotfiles) is not the project: climbing there would scan and install into ~.
  const home = await realpathOrNull(homeDirectory);
  const git = Boolean(topLevel) && topLevel !== home;
  const boundary = await cleanBoundary(startedIn, git ? topLevel : home);
  const root = boundary ?? (git ? topLevel : startedIn);
  return { root, startedIn, git, fromSubfolder: root !== startedIn, ...projectIdentity(root) };
}
