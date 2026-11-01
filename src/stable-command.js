// ~/.nexakit/nexakit: a small launcher that runs nexakit from its active root with a fixed node, so skills and the
// person can call nexakit without npx and without nexakit on the PATH. It is rewritten only when its content
// changes, and a link or a folder in its place is never replaced.
import fs from 'node:fs/promises';
import path from 'node:path';
import { IS_WINDOWS } from './platform.js';
import { nexakitDir } from './stable-install.js';

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function stableCommandContent({ nodePath, toolkitRoot, windows = IS_WINDOWS }) {
  return windows
    ? `@"${nodePath}" "${toolkitRoot}\\bin\\nexakit.js" %*\r\n`
    : `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(path.join(toolkitRoot, 'bin', 'nexakit.js'))} "$@"\n`;
}

export async function planStableCommand({ homeDirectory, nodePath, toolkitRoot, windows = IS_WINDOWS }) {
  const target = path.join(nexakitDir(homeDirectory), windows ? 'nexakit.cmd' : 'nexakit');
  const content = stableCommandContent({ nodePath, toolkitRoot, windows });
  let state;
  try {
    const info = await fs.lstat(target);
    state = !info.isFile() ? 'conflicto' : (await fs.readFile(target, 'utf8')) === content ? 'igual' : 'distinto';
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = 'falta';
  }
  return { path: target, content, state, windows };
}

export async function writeStableCommand(plan, lock) {
  if (plan.state === 'igual' || plan.state === 'conflicto') return false;
  await lock.assertHeld();
  await fs.mkdir(path.dirname(plan.path), { recursive: true, mode: 0o700 });
  const temporary = `${plan.path}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, plan.content, { mode: 0o755, flag: 'wx' });
    await fs.chmod(temporary, 0o755);
    await lock.assertHeld();
    // Read again right before replacing: something that became a link or a folder meanwhile is left alone.
    const current = await fs.lstat(plan.path).catch(error => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (current && !current.isFile()) return false;
    await fs.rename(temporary, plan.path);
    return true;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
