import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Las reglas del registro son las del mod, para que el resumen y el aviso de sesión nunca discrepen.
import { leerEventos, sinGuardar } from '../plugins/nexakit-lecciones/hooks/lecciones.js';

const DIA_MS = 24 * 60 * 60 * 1000;
const MAX_PENDIENTES_TEXTO = 5;
const USO = 'Uso: nexakit lecciones [--json | --descartar]\n';

function resumir(eventos) {
  const cuenta = (tipo) => eventos.filter((e) => e.tipo === tipo).length;
  return {
    correcciones: cuenta('correccion'),
    leccionesGuardadas: cuenta('guardada'),
    erroresFrenados: cuenta('freno'),
    erroresRepetidos: cuenta('repeticion'),
  };
}

// Las más recientes primero.
const pendientes = (eventos) => sinGuardar(eventos).reverse().map((e) => (typeof e.texto === 'string' ? e.texto : ''));

export async function runLeccionesCommand(argv, { out, err }, options = {}) {
  const json = argv.includes('--json');
  const descartar = argv.includes('--descartar');
  if (argv.some((a) => a !== '--json' && a !== '--descartar') || (json && descartar)) {
    await err(USO);
    return 2;
  }
  const home = options.homeDirectory ?? os.homedir();
  const ahora = options.now ?? Date.now();
  const ruta = path.join(home, '.nexakit', 'lecciones.jsonl');
  let texto = null;
  try {
    texto = await fs.readFile(ruta, 'utf8');
  } catch {
    texto = null;
  }
  const eventos = texto === null ? [] : leerEventos(texto);
  if (descartar) {
    // Para las correcciones que no eran tales o que ya no valen: se dan por resueltas sin borrar el historial.
    const cuantas = sinGuardar(eventos).length;
    if (cuantas === 0) {
      await out('No hay correcciones pendientes que descartar.\n');
      return 0;
    }
    const base = texto.endsWith('\n') ? texto : `${texto}\n`;
    await fs.writeFile(ruta, `${base}${JSON.stringify({ fecha: ahora, tipo: 'descartada' })}\n`);
    await out(`${cuantas === 1 ? '1 corrección descartada' : `${cuantas} correcciones descartadas`}; el historial se conserva.\n`);
    return 0;
  }
  const resumen = {
    ultimos7Dias: resumir(eventos.filter((e) => e.fecha >= ahora - 7 * DIA_MS)),
    total: resumir(eventos),
    pendientes: pendientes(eventos),
  };
  if (json) {
    await out(`${JSON.stringify(resumen, null, 2)}\n`);
    return 0;
  }
  if (eventos.length === 0) {
    await out(
      'Aún no hay lecciones registradas. El registro lo escribe el mod nexakit-lecciones cuando detecta una corrección o un error repetido.\n',
    );
    return 0;
  }
  const formato = (titulo, r) =>
    `${titulo}: ${r.correcciones} correcciones, ${r.leccionesGuardadas} lecciones guardadas, ${r.erroresFrenados} errores frenados, ${r.erroresRepetidos} errores repetidos tres veces\n`;
  await out(formato('Últimos 7 días', resumen.ultimos7Dias));
  await out(formato('Total', resumen.total));
  const p = resumen.pendientes;
  if (p.length === 0) {
    await out('Pendientes: ninguna corrección sin guardar como lección.\n');
  } else {
    await out(`Pendientes: ${p.length} correcciones sin guardar como lección (si ya no valen: nexakit lecciones --descartar)\n`);
    for (const t of p.slice(0, MAX_PENDIENTES_TEXTO)) await out(`  - ${t}\n`);
    if (p.length > MAX_PENDIENTES_TEXTO) await out(`  ... y ${p.length - MAX_PENDIENTES_TEXTO} más (usa --json para verlas todas)\n`);
  }
  return 0;
}
