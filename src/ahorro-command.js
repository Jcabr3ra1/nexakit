import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIA_MS = 24 * 60 * 60 * 1000;
const MAX_REGISTRO_BYTES = 1024 * 1024;

async function directorioSeguro(target) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Directorio inseguro');
  }
}

async function leerFuente(target) {
  let handle;
  try {
    await directorioSeguro(path.dirname(target));
    const before = await fs.lstat(target);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_REGISTRO_BYTES) return [];
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_REGISTRO_BYTES ||
        opened.dev !== before.dev || opened.ino !== before.ino) return [];
    // Un byte adicional detecta crecimiento sin una lectura sin límite.
    const buffer = Buffer.alloc(MAX_REGISTRO_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await handle.stat();
    await directorioSeguro(path.dirname(target));
    const final = await fs.lstat(target);
    if (size > MAX_REGISTRO_BYTES || after.nlink !== 1 || !final.isFile() || final.nlink !== 1 ||
        final.dev !== opened.dev || final.ino !== opened.ino) return [];
    return leerRegistros(buffer.subarray(0, size).toString('utf8'));
  } catch {
    // Una fuente ausente o insegura no impide consultar la otra.
    return [];
  } finally {
    await handle?.close();
  }
}

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
  const fuentes = new Set([path.resolve(home, '.nexakit', 'ahorro.jsonl')]);
  try {
    // El temporal del sistema puede ser un alias (por ejemplo /var en macOS).
    const temporal = await fs.realpath(options.tempDirectory ?? os.tmpdir());
    fuentes.add(path.join(temporal, `nexakit-codex-${process.getuid?.() ?? 'user'}`, '.nexakit', 'ahorro.jsonl'));
  } catch {
    // No se crean directorios al consultar métricas.
  }
  const registros = [];
  for (const fuente of fuentes) registros.push(...await leerFuente(fuente));
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
      'Aún no hay recortes registrados. Los escriben el mod nexakit-ahorro de Claude y nexakit codex ejecutar al recortar salidas largas.\n',
    );
    return 0;
  }
  const formato = (titulo, r) =>
    `${titulo}: ${r.recortes} recortes, ${r.caracteresEvitados} caracteres evitados, ~${r.tokensEstimados} tokens (estimación: caracteres/4)\n`;
  await out(formato('Últimos 7 días', resumen.ultimos7Dias));
  await out(formato('Total', resumen.total));
  return 0;
}
