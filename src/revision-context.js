import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectRoot } from './project-root.js';

const runGit = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
});
const splitNames = text => String(text).split('\0').filter(Boolean);

export async function collectRevisionContext({ start = process.cwd(), base, homeDirectory, runGit: run = runGit } = {}) {
  const { root, git } = await resolveProjectRoot(start, { homeDirectory, runGit: run });
  if (!git) throw new Error('La revisión necesita un repositorio Git.');
  const resolveCommit = ref => {
    if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\0\r\n]/u.test(ref)) throw new Error('Base de revisión inválida.');
    return String(run(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], root)).trim();
  };
  if (base === undefined) {
    try {
      const remote = String(run(['symbolic-ref', 'refs/remotes/origin/HEAD'], root)).trim();
      resolveCommit(remote);
      base = remote;
    } catch {
      const found = ['main', 'master'].filter(ref => {
        try { resolveCommit(`refs/heads/${ref}`); return true; } catch { return false; }
      });
      if (found.length !== 1) throw new Error('Base principal ausente o ambigua; indica --base.');
      base = found[0];
    }
  }
  // Use the resolved object id for every diff, so a branch moving cannot mix bases.
  const commit = resolveCommit(base);
  const tracked = splitNames(run(['diff', '--no-ext-diff', '--name-only', '-z', commit, '--'], root));
  const untracked = splitNames(run(['ls-files', '--others', '--exclude-standard', '-z'], root));
  const changedFiles = [...new Set([...tracked, ...untracked])].sort();
  let diff = String(run(['diff', '--no-ext-diff', '--no-textconv', commit, '--'], root));
  for (const name of untracked) {
    const file = path.join(root, name), stat = await fs.lstat(file);
    const heading = `\nArchivo nuevo: ${JSON.stringify(name)}\n`;
    if (stat.isSymbolicLink()) diff += `${heading}Enlace: ${await fs.readlink(file)}\n`;
    else if (!stat.isFile()) diff += `${heading}Archivo especial: sin contenido textual\n`;
    else {
      if (stat.size > 1024 * 1024) throw new Error('Archivo nuevo demasiado grande para revisar (máximo 1 MiB).');
      const contents = await fs.readFile(file);
      diff += heading + (contents.includes(0) ? 'Binario: sin diff textual\n' : contents.toString('utf8') + '\n');
    }
    if (Buffer.byteLength(diff) > 16 * 1024 * 1024) throw new Error('El contexto de revisión supera 16 MiB.');
  }
  return { root, base, diff, changedFiles };
}
