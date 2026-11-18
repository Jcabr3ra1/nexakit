import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const ejecutar = promisify(exec);

export interface OpcionesRespaldo {
  origen: string;
  destino: string;
  prefijo?: string;
}

export async function comprimirCarpeta({ origen, destino, prefijo }: OpcionesRespaldo): Promise<void> {
  const nombre = prefijo ? `${prefijo}-${destino}` : destino;
  await ejecutar(`tar -czf ${nombre} -C ${origen} .`);
}
