import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const ejecutar = promisify(exec);

export interface OpcionesRespaldo {
  origen: string;
  destino: string;
}

export async function comprimirCarpeta({ origen, destino }: OpcionesRespaldo): Promise<void> {
  await ejecutar(`tar -czf ${destino} -C ${origen} .`);
}
