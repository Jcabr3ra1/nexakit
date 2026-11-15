// Ruta de un archivo de configuración global de git vacío, creado una sola vez en un directorio temporal.
// Sustituye a `os.devNull` en GIT_CONFIG_GLOBAL: en Windows es `\\.\nul` y git falla con «unable to access».
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'nexakit-gitconfig-'));
export const gitConfigGlobalVacio = join(dir, 'gitconfig');
writeFileSync(gitConfigGlobalVacio, '');
process.on('exit', () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});
