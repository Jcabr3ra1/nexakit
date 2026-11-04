// `nexakit panel`: dibuja a pantalla completa la orquesta de la sesión de Claude Code (líder, asesor, subagentes,
// uso). El mod nexakit-panel guarda una foto del estado real en ~/.nexakit/panel/actual.json en cada cambio; este
// comando la lee cada segundo y la pinta con el mismo lienzo que usa el panel dentro de Claude.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ANCHO, aAnsi, dibujar } from '../plugins/nexakit-panel/hooks/lienzo.js';
import { ejemplo, hora } from '../plugins/nexakit-panel/hooks/panel.js';
import { colorLevel } from './brand.js';
import { cellWidth, fitLine } from './terminal-text.js';

export const INACTIVA_MS = 10 * 60 * 1000;
const USO_EJEMPLO = { context: { window: 1000000, percent: 55 }, rateLimits: [{ kind: 'five_hour', percentUsed: 14 }, { kind: 'seven_day', percentUsed: 79 }] };
const AYUDA = `Uso: nexakit panel [--demo] [--una-vez]

Dibuja la orquesta de tu sesión de Claude Code a pantalla completa: ábrelo en una división de la terminal al
lado de Claude. Se actualiza solo cada segundo; q o Ctrl+C para salir. Necesita el mod nexakit-panel en
Claude Code y una ventana de al menos ${ANCHO} columnas.
  --demo      datos de ejemplo, marcados como ficticios, para ver el diseño
  --una-vez   dibuja una vez y sale
`;

export async function leerFoto(homeDirectory) {
  try {
    const foto = JSON.parse(await fs.readFile(path.join(homeDirectory, '.nexakit', 'panel', 'actual.json'), 'utf8'));
    return foto?.version === 1 && foto.estado && typeof foto.estado === 'object' ? foto : null;
  } catch {
    return null;
  }
}

const centrada = (texto, columnas) => {
  const t = fitLine(texto, columnas);
  return ' '.repeat(Math.max(0, Math.floor((columnas - cellWidth(t)) / 2))) + t;
};
const tenue = (texto, nivel) => (nivel === 'none' ? texto : `\x1b[2m${texto}\x1b[22m`);

export function marcoDelPanel({ foto, columnas = ANCHO, filas, nivel = 'none', ahora = Date.now(), demo = false }) {
  if (columnas < ANCHO) {
    return ['', centrada('NEXAKIT · ORQUESTA', columnas), '',
      centrada(`El panel necesita ${ANCHO} columnas (ahora ${columnas}).`, columnas),
      tenue(centrada('Ensancha esta división de la terminal.', columnas), nivel)].join('\n');
  }
  const estado = demo ? ejemplo(ahora) : foto?.estado;
  if (!estado) {
    return ['', centrada('NEXAKIT · ORQUESTA', columnas), '',
      centrada('Esperando actividad de Claude Code…', columnas),
      tenue(centrada('Abre Claude Code con el mod nexakit-panel y trabaja con normalidad: este panel se llena solo.', columnas), nivel)].join('\n');
  }
  const quieta = !demo && Number.isFinite(foto?.actualizado) && ahora - foto.actualizado > INACTIVA_MS;
  const { filas: lineas } = dibujar(estado, {
    ahora,
    uso: demo ? USO_EJEMPLO : foto.uso,
    carpeta: demo ? 'app' : foto.carpeta,
    filasMax: filas ? filas - 1 - (quieta ? 1 : 0) : undefined,
    asesorModelo: demo ? null : foto.asesorModelo,
    esEjemplo: demo,
  });
  const margen = ' '.repeat(Math.floor((columnas - ANCHO) / 2));
  const cuerpo = aAnsi(lineas, nivel).split('\n').map((linea) => margen + linea);
  if (quieta) cuerpo.push(tenue(`${margen}  sin actividad desde ${hora(foto.actualizado)}`, nivel));
  return cuerpo.join('\n');
}

export async function runPanelCommand(rest, { out, err, input = process.stdin, output = process.stdout, isTTY, options = {} }) {
  const flags = new Set(rest);
  if (rest.some((a) => !['--demo', '--una-vez', '--help', '-h'].includes(a)) || flags.size !== rest.length) {
    await err(AYUDA);
    return 2;
  }
  if (flags.has('--help') || flags.has('-h')) {
    await out(AYUDA);
    return 0;
  }
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const demo = flags.has('--demo');
  const interactive = !flags.has('--una-vez') && Boolean(isTTY ?? (input?.isTTY && output?.isTTY));
  const nivel = interactive ? colorLevel(output) : 'none';
  const marco = async () => marcoDelPanel({
    foto: demo ? null : await leerFoto(homeDirectory),
    columnas: output?.columns || (interactive ? 80 : 120),
    filas: interactive ? output?.rows : undefined,
    nivel,
    ahora: Date.now(),
    demo,
  });

  if (!interactive) {
    await out(`${await marco()}\n`);
    return 0;
  }

  // Pantalla alterna: se redibuja en el sitio, línea a línea, sin parpadeo ni llenar el historial.
  return new Promise((resolve) => {
    let cerrado = false;
    let dibujando = false;
    const pintar = async () => {
      if (cerrado || dibujando) return;
      dibujando = true;
      try {
        const texto = await marco();
        if (!cerrado) output.write(`\x1b[H${texto.split('\n').map((l) => `${l}\x1b[K`).join('\n')}\x1b[J`);
      } finally {
        dibujando = false;
      }
    };
    const reloj = setInterval(pintar, 1000);
    const cerrar = () => {
      if (cerrado) return;
      cerrado = true;
      clearInterval(reloj);
      input.off?.('data', alPulsar);
      output.off?.('resize', pintar);
      try { if (typeof input.setRawMode === 'function') input.setRawMode(false); } catch {}
      try { input.pause?.(); } catch {}
      output.write('\x1b[?25h\x1b[?1049l');
      resolve(0);
    };
    const alPulsar = (datos) => {
      const tecla = String(datos);
      if (tecla === 'q' || tecla === 'Q' || tecla === '\x03') cerrar();
    };
    output.write('\x1b[?1049h\x1b[?25l');
    try { if (typeof input.setRawMode === 'function') input.setRawMode(true); } catch {}
    input.on?.('data', alPulsar);
    input.resume?.();
    output.on?.('resize', pintar);
    pintar();
  });
}
