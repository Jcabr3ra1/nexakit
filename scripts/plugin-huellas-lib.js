import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../plugins/', import.meta.url));
export const RUTA_HUELLAS = fileURLToPath(new URL('../plugins/huellas.json', import.meta.url));
// Lo que el motor genera o solo usan las pruebas no cuenta: no llega al usuario.
const IGNORAR = new Set(['types', 'tests', 'tsconfig.json', 'node_modules']);

function archivos(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => !IGNORAR.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? archivos(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

export function huellasActuales() {
  const resultado = {};
  for (const e of fs.readdirSync(RAIZ, { withFileTypes: true }).filter((x) => x.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(RAIZ, e.name);
    const manifiesto = path.join(dir, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifiesto)) continue;
    const { version } = JSON.parse(fs.readFileSync(manifiesto, 'utf8'));
    const hash = crypto.createHash('sha256');
    for (const f of archivos(dir)) {
      const rel = path.relative(dir, f).split(path.sep).join('/');
      let contenido = fs.readFileSync(f, 'utf8').replace(/\r\n/gu, '\n');
      // La versión no forma parte de la huella: así se puede comparar «mismo código, otra versión».
      if (rel === '.claude-plugin/plugin.json') contenido = JSON.stringify({ ...JSON.parse(contenido), version: undefined });
      hash.update(`${rel}\0${contenido}\0`);
    }
    resultado[e.name] = { version, huella: hash.digest('hex').slice(0, 16) };
  }
  return resultado;
}
