import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DIA_MS = 24 * 60 * 60 * 1000;

function resumir(registros) {
  const caracteres = registros.reduce((suma, r) => suma + (r.antes - r.despues), 0);
  return {
    recortes: registros.length,
    caracteresEvitados: caracteres,
    tokensEstimados: Math.round(caracteres / 4),
  };
}

function leerRegistros(texto) {
  const registros = [];
  for (const linea of texto.split('\n')) {
    if (!linea.trim()) continue;
    try {
      const r = JSON.parse(linea);
      if ([r?.fecha, r?.antes, r?.despues].every((n) => Number.isFinite(n))) registros.push(r);
    } catch {
      // Se ignoran las líneas inválidas.
    }
  }
  return registros;
}

export async function runAhorroCommand(argv, { out, err }, options = {}) {
  const json = argv.includes('--json');
  if (argv.some((a) => a !== '--json')) {
    await err('Uso: nexakit ahorro [--json]\n');
    return 2;
  }
  const home = options.homeDirectory ?? os.homedir();
  const ahora = options.now ?? Date.now();
  let texto = null;
  try {
    texto = await fs.readFile(path.join(home, '.nexakit', 'ahorro.jsonl'), 'utf8');
  } catch {
    texto = null;
  }
  const registros = texto === null ? [] : leerRegistros(texto);
  const resumen = {
    ultimos7Dias: resumir(registros.filter((r) => r.fecha >= ahora - 7 * DIA_MS)),
    total: resumir(registros),
  };
  if (json) {
    await out(`${JSON.stringify(resumen, null, 2)}\n`);
    return 0;
  }
  if (registros.length === 0) {
    await out(
      'Aún no hay recortes registrados. El registro lo escribe el mod nexakit-ahorro cuando recorta una salida larga de Bash.\n',
    );
    return 0;
  }
  const formato = (titulo, r) =>
    `${titulo}: ${r.recortes} recortes, ${r.caracteresEvitados} caracteres evitados, ~${r.tokensEstimados} tokens (estimación: caracteres/4)\n`;
  await out(formato('Últimos 7 días', resumen.ultimos7Dias));
  await out(formato('Total', resumen.total));
  return 0;
}
