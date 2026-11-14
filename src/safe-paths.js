import fs from 'node:fs/promises';
import path from 'node:path';

async function isDarwinSystemLink(current) {
  if (process.platform !== 'darwin' || (current !== '/tmp' && current !== '/var')) return false;
  return (await fs.realpath(current).catch(() => null)) === `/private${current}`;
}

/**
 * Rechaza destinos con enlaces simbólicos en el propio destino o en sus ancestros.
 * Con `allowDarwinSystemLinks` se toleran los enlaces de sistema de macOS (`/tmp` y `/var` hacia `/private`).
 */
export async function assertNoSymlinkAncestors(destination, { allowDarwinSystemLinks = false } = {}) {
  const systemLink = async (current) => allowDarwinSystemLinks && isDarwinSystemLink(current);
  let current = destination;
  while (true) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() && !(await systemLink(current))) {
        throw new Error('No se admiten enlaces simbólicos en el destino.');
      }
      if (current !== destination && !stat.isDirectory() && !(await systemLink(current))) {
        throw new Error('El padre no es una carpeta.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Indica si `destination` es `root` o queda dentro de él. */
export const within = (root, destination) => {
  const relative = path.relative(path.resolve(root), destination);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
