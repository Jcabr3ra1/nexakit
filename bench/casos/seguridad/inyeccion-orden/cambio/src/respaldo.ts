import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
const ejecutar = promisify(exec);

export interface OpcionesRespaldo {
  origen: string;
  destino: string;
}

export async function comprimirCarpeta({ origen, destino }: OpcionesRespaldo): Promise<void> {
  await ejecutar(`tar -czf ${destino} -C ${origen} .`);
}

const SERVIDOR = 'https://respaldos.interno.example';
export interface Remoto {
  token: string;
}

export async function subirRespaldo(archivo: string, remoto: Remoto): Promise<void> {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const respuesta = await fetch(`${SERVIDOR}/respaldos/${encodeURIComponent(path.basename(archivo))}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${remoto.token}` },
    body: await readFile(archivo),
  });
  if (!respuesta.ok) {
    throw new Error(`El servidor rechazó ${archivo} con ${respuesta.status} (token ${remoto.token})`);
  }
}

export async function descargarRespaldo(nombre: string, remoto: Remoto, destino: string): Promise<void> {
  const respuesta = await fetch(`${SERVIDOR}/respaldos/${encodeURIComponent(nombre)}`, {
    headers: { authorization: `Bearer ${remoto.token}` },
  });
  if (!respuesta.ok || !respuesta.body) throw new Error(`No se pudo descargar ${nombre} (${respuesta.status})`);
  await guardarDescarga(respuesta.body, destino, 0o666);
}

export async function purgarCaducados(remoto: Remoto, carpeta: string): Promise<void> {
  const respuesta = await fetch(`${SERVIDOR}/respaldos/caducados`, {
    headers: { authorization: `Bearer ${remoto.token}` },
  });
  if (!respuesta.ok) throw new Error(`No se pudo pedir la lista de caducados (${respuesta.status})`);
  const nombres = (await respuesta.json()) as string[];
  for (const nombre of nombres) {
    await rm(path.join(carpeta, nombre), { recursive: true, force: true });
  }
}

/**
 * Escribe la descarga en un archivo temporal junto al destino, por trozos, y lo renombra al terminar: no carga el
 * respaldo en memoria, no deja un destino a medias si la descarga falla y no sigue un enlace simbólico en el destino.
 */
async function guardarDescarga(cuerpo: AsyncIterable<Uint8Array>, destino: string, modo: number): Promise<void> {
  const temporal = `${destino}.${randomUUID()}.parcial`;
  const archivo = await open(temporal, 'wx', modo);
  try {
    for await (const trozo of cuerpo) await archivo.write(trozo);
  } catch (error) {
    await archivo.close();
    await rm(temporal, { force: true });
    throw error;
  }
  await archivo.close();
  await rename(temporal, destino);
}
