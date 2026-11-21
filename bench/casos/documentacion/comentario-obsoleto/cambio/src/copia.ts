import { writeFile } from 'node:fs/promises';
import { listarUsuarios } from './usuarios.js';

/** Guarda en `ruta` una copia en JSON de todos los usuarios, también los dados de baja. */
export async function guardarCopia(ruta: string): Promise<void> {
  const todos = listarUsuarios({ limite: Number.POSITIVE_INFINITY });
  await writeFile(ruta, JSON.stringify(todos, null, 2));
}
