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

export interface Preferencias {
  criterio: Criterio;
  revisionCruzada: boolean;
}

const PREDETERMINADAS: Preferencias = { criterio: CRITERIO_PREDETERMINADO, revisionCruzada: true };

export async function leerPreferencias(home: string): Promise<Preferencias> {
  const nexakit = path.join(home, '.nexakit');
  const fabrica = path.join(nexakit, 'fabrica');
  try {
    for (const carpeta of [nexakit, fabrica]) {
      if (!(await lstatSiExiste(carpeta))?.isDirectory()) return { ...PREDETERMINADAS };
    }
    const archivo = await open(path.join(fabrica, NOMBRE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await archivo.stat()).isFile()) return { ...PREDETERMINADAS };
      const datos: unknown = JSON.parse(await archivo.readFile('utf8'));
      if (typeof datos === 'object' && datos !== null) {
        return {
          criterio: 'criterio' in datos && esCriterio(datos.criterio) ? datos.criterio : PREDETERMINADAS.criterio,
          revisionCruzada: 'revisionCruzada' in datos && typeof datos.revisionCruzada === 'boolean'
            ? datos.revisionCruzada
            : PREDETERMINADAS.revisionCruzada,
        };
      }
    } finally {
      await archivo.close();
    }
  } catch {
    // Una preferencia ausente o ilegible equivale al valor predeterminado.
  }
  return { ...PREDETERMINADAS };
}

export async function leerCriterio(home: string): Promise<Criterio> {
  return (await leerPreferencias(home)).criterio;
}

export async function guardarPreferencias(home: string, cambios: Partial<Preferencias>): Promise<Preferencias> {
  const nexakit = path.join(home, '.nexakit');
  const fabrica = path.join(nexakit, 'fabrica');
  await carpetaPropia(nexakit, 'La configuración de la fábrica');
  await carpetaPropia(fabrica, 'La configuración de la fábrica');
  const preferencias = { ...await leerPreferencias(home), ...cambios };
  await escribirReemplazando(path.join(fabrica, NOMBRE), `${JSON.stringify(preferencias, null, 2)}\n`);
  return preferencias;
}

export async function guardarCriterio(home: string, criterio: Criterio): Promise<void> {
  await guardarPreferencias(home, { criterio });
}
