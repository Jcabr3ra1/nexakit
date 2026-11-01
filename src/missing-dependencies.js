import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEphemeralPath } from './link-states.js';

// This file must stay free of third-party imports: it has to run exactly when they are missing.
const copyRoot = () => path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// Loads a module of nexakit. If a third-party package is missing in a checkout, says how to install it instead
// of showing a stack trace. Any other failure is raised untouched, and so is a missing package under npx,
// where `npm ci` would be the wrong advice.
export async function loadWithDependencyCheck(load, { root = copyRoot(), write = text => process.stderr.write(text) } = {}) {
  try {
    return await load();
  } catch (error) {
    const missingPackage = error?.code === 'ERR_MODULE_NOT_FOUND' && /^Cannot find package '/u.test(error.message ?? '');
    if (!missingPackage || isEphemeralPath(root)) throw error;
    write(`Faltan las dependencias de esta copia. Ejecuta \`npm ci\` en ${root}.\n`);
    process.exitCode = 1;
    return null;
  }
}
