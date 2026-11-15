import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigFabrica } from './esquemas.js';
import { ErrorFabrica } from './errores.js';

/** Ruta del archivo de configuración, relativa a la raíz del proyecto. */
export const RUTA_CONFIG = path.join('.nexakit', 'fabrica.json');

/**
 * Carga `.nexakit/fabrica.json`. Si no existe devuelve los valores por defecto;
 * si es inválido rechaza con un `ErrorFabrica` que nombra el campo.
 */
export async function cargarConfig(raiz: string): Promise<ConfigFabrica> {
  const archivo = path.join(raiz, RUTA_CONFIG);
  let texto: string;
  try {
    texto = await readFile(archivo, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ConfigFabrica.parse({});
    throw new ErrorFabrica(`No se pudo leer ${RUTA_CONFIG}: ${(error as Error).message}`, {
      cause: error,
    });
  }
  let datos: unknown;
  try {
    datos = JSON.parse(texto.replace(/^﻿/u, ''));
  } catch (error) {
    throw new ErrorFabrica(`${RUTA_CONFIG} no es un JSON válido: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const resultado = ConfigFabrica.safeParse(datos);
  if (!resultado.success) {
    const detalle = resultado.error.issues
      .map((problema) => {
        const campo = problema.path.length > 0 ? problema.path.map(String).join('.') : '(raíz)';
        return `campo «${campo}»: ${problema.message}`;
      })
      .join('; ');
    throw new ErrorFabrica(`${RUTA_CONFIG} es inválido: ${detalle}`, { cause: resultado.error });
  }
  return resultado.data;
}
