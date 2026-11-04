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

// La sesión más reciente de Codex (~/.codex/sessions/AAAA/MM/DD/*.jsonl): modelo, tokens y límites. Es un formato
// interno de Codex: si cambia o falta algo, se devuelve null en vez de inventar cifras.
export async function leerCodex(codexHome) {
  try {
    const base = path.join(codexHome, 'sessions');
    const desc = async (dir) => (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
    const archivos = [];
    for (const anio of (await desc(base)).slice(0, 2))
      for (const mes of (await desc(path.join(base, anio))).slice(0, 2))
        for (const dia of (await desc(path.join(base, anio, mes))).slice(0, 3))
          for (const nombre of await fs.readdir(path.join(base, anio, mes, dia)).catch(() => []))
            if (nombre.endsWith('.jsonl')) archivos.push(path.join(base, anio, mes, dia, nombre));
    if (archivos.length === 0) return null;
    const conFecha = await Promise.all(archivos.map(async (f) => ({ f, t: (await fs.stat(f)).mtimeMs })));
    const { f, t } = conFecha.sort((a, b) => b.t - a.t)[0];
    const datos = await fs.readFile(f);
    const lineas = datos.subarray(Math.max(0, datos.length - 1_048_576)).toString('utf8').split('\n');
    let cuenta = null, turno = null;
    for (let i = lineas.length - 1; i >= 0 && !(cuenta && turno); i--) {
      let d;
      try { d = JSON.parse(lineas[i]); } catch { continue; }
      if (!cuenta && d?.payload?.type === 'token_count' && d.payload.info?.total_token_usage) cuenta = d.payload;
      if (!turno && d?.type === 'turn_context' && d.payload?.model) turno = d.payload;
    }
    if (!cuenta) return null;
    const total = cuenta.info.total_token_usage;
    const numero = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      modelo: turno?.model ?? null,
      esfuerzo: turno?.effort ?? null,
      leidos: numero(total.input_tokens) ?? 0,
      cache: numero(total.cached_input_tokens) ?? 0,
      escritos: numero(total.output_tokens) ?? 0,
      limite5h: numero(cuenta.rate_limits?.primary?.used_percent),
      limiteSemana: numero(cuenta.rate_limits?.secondary?.used_percent),
      actualizado: t,
    };
  } catch {
    return null;
  }
}

const centrada = (texto, columnas) => {
  const t = fitLine(texto, columnas);
  return ' '.repeat(Math.max(0, Math.floor((columnas - cellWidth(t)) / 2))) + t;
};
const tenue = (texto, nivel) => (nivel === 'none' ? texto : `\x1b[2m${texto}\x1b[22m`);

export function marcoDelPanel({ foto, columnas = ANCHO, filas, nivel = 'none', ahora = Date.now(), demo = false, codex = null }) {
  if (columnas < ANCHO) {
    return ['', centrada('NEXAKIT · ORQUESTA', columnas), '',
      centrada(`El panel necesita ${ANCHO} columnas (ahora ${columnas}).`, columnas),
      tenue(centrada('Ensancha esta división de la terminal.', columnas), nivel)].join('\n');
  }
  const estado = demo ? ejemplo(ahora) : foto?.estado;
  if (!estado && codex) {
    const { filas: lineas } = dibujar({ ...ejemplo(ahora), pasos: 0, agentes: [], registro: [] }, { ahora, uso: null, codex });
    const margen = ' '.repeat(Math.floor((columnas - ANCHO) / 2));
    return [...aAnsi(lineas, nivel).split('\n').map((l) => margen + l), tenue(centrada('Sin actividad de Claude Code todavía.', columnas), nivel)].join('\n');
  }
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
    codex,
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
  const environment = options.environment ?? process.env;
  const codexHome = options.codexHome ?? environment.CODEX_HOME ?? path.join(homeDirectory, '.codex');
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
    codex: await leerCodex(codexHome),
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
