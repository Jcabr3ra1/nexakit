import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DIA_MS = 24 * 60 * 60 * 1000;
const TIPOS = ['correccion', 'guardada', 'avisada', 'freno', 'repeticion'];
const MAX_PENDIENTES_TEXTO = 5;

function resumir(eventos) {
  const cuenta = (tipo) => eventos.filter((e) => e.tipo === tipo).length;
  return {
    correcciones: cuenta('correccion'),
    leccionesGuardadas: cuenta('guardada'),
    erroresFrenados: cuenta('freno'),
    erroresRepetidos: cuenta('repeticion'),
  };
}

function leerEventos(texto) {
  const eventos = [];
  for (const linea of texto.split('\n')) {
    if (!linea.trim()) continue;
    try {
      const e = JSON.parse(linea);
      if (Number.isFinite(e?.fecha) && TIPOS.includes(e?.tipo)) eventos.push(e);
    } catch {
      // Se ignoran las líneas inválidas.
    }
  }
  return eventos;
}

// Por orden en el registro, no por hora: dos eventos pueden caer en el mismo milisegundo.
function pendientes(eventos) {
  let ultima = -1;
  eventos.forEach((e, i) => { if (e.tipo === 'guardada') ultima = i; });
  return eventos
    .slice(ultima + 1)
    .filter((e) => e.tipo === 'correccion')
    .reverse()
    .map((e) => (typeof e.texto === 'string' ? e.texto : ''));
}

export async function runLeccionesCommand(argv, { out, err }, options = {}) {
  const json = argv.includes('--json');
  if (argv.some((a) => a !== '--json')) {
    await err('Uso: nexakit lecciones [--json]\n');
    return 2;
  }
  const home = options.homeDirectory ?? os.homedir();
  const ahora = options.now ?? Date.now();
  let texto = null;
  try {
    texto = await fs.readFile(path.join(home, '.nexakit', 'lecciones.jsonl'), 'utf8');
  } catch {
    texto = null;
  }
  const eventos = texto === null ? [] : leerEventos(texto);
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
    await out(`Pendientes: ${p.length} correcciones sin guardar como lección\n`);
    for (const t of p.slice(0, MAX_PENDIENTES_TEXTO)) await out(`  - ${t}\n`);
    if (p.length > MAX_PENDIENTES_TEXTO) await out(`  ... y ${p.length - MAX_PENDIENTES_TEXTO} más (usa --json para verlas todas)\n`);
  }
  return 0;
}
