import { exec } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
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
  await writeFile(destino, respuesta.body, { mode: 0o666, flag: 'wx' });
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
