// Registra la huella de cada plugin. Claude Code solo actualiza un plugin instalado cuando cambia su `version`,
// así que un cambio de código sin subir la versión nunca llega a quien ya lo tiene. Este script se niega a
// registrar una huella nueva si la versión no cambió.
import fs from 'node:fs';
import path from 'node:path';
import { huellasActuales, RUTA_HUELLAS } from './plugin-huellas-lib.js';

const registradas = fs.existsSync(RUTA_HUELLAS) ? JSON.parse(fs.readFileSync(RUTA_HUELLAS, 'utf8')) : {};
const actuales = huellasActuales();
const errores = [];
for (const [nombre, { version, huella }] of Object.entries(actuales)) {
  const antes = registradas[nombre];
  if (antes && antes.huella !== huella && antes.version === version)
    errores.push(`${nombre}: cambió su código pero sigue en ${version}; sube "version" en plugins/${nombre}/.claude-plugin/plugin.json`);
}
if (errores.length > 0) {
  console.error(errores.join('\n'));
  process.exit(1);
}
fs.writeFileSync(RUTA_HUELLAS, `${JSON.stringify(actuales, null, 2)}\n`);
console.log(`Huellas registradas en ${path.relative(process.cwd(), RUTA_HUELLAS)}`);
