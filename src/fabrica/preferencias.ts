import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { carpetaPropia, escribirReemplazando, lstatSiExiste } from './rastro.js';

export type Criterio = 'calidad' | 'barato';
export const CRITERIO_PREDETERMINADO: Criterio = 'barato';

export function esCriterio(valor: unknown): valor is Criterio {
  return valor === 'calidad' || valor === 'barato';
}

const NOMBRE = 'preferencias.json';

export async function leerCriterio(home: string): Promise<Criterio> {
  const nexakit = path.join(home, '.nexakit');
  const fabrica = path.join(nexakit, 'fabrica');
  try {
    for (const carpeta of [nexakit, fabrica]) {
      if (!(await lstatSiExiste(carpeta))?.isDirectory()) return CRITERIO_PREDETERMINADO;
    }
    const archivo = await open(path.join(fabrica, NOMBRE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await archivo.stat()).isFile()) return CRITERIO_PREDETERMINADO;
      const datos: unknown = JSON.parse(await archivo.readFile('utf8'));
      if (typeof datos === 'object' && datos !== null && 'criterio' in datos && esCriterio(datos.criterio)) {
        return datos.criterio;
      }
    } finally {
      await archivo.close();
    }
  } catch {
    // Una preferencia ausente o ilegible equivale al valor predeterminado.
  }
  return CRITERIO_PREDETERMINADO;
}

export async function guardarCriterio(home: string, criterio: Criterio): Promise<void> {
  const nexakit = path.join(home, '.nexakit');
  const fabrica = path.join(nexakit, 'fabrica');
  await carpetaPropia(nexakit, 'La configuración de la fábrica');
  await carpetaPropia(fabrica, 'La configuración de la fábrica');
  await escribirReemplazando(path.join(fabrica, NOMBRE), `${JSON.stringify({ criterio }, null, 2)}\n`);
}
