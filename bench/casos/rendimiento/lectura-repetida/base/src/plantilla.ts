import { readFileSync } from 'node:fs';

const PLANTILLA = readFileSync(new URL('./correo.html', import.meta.url), 'utf8');

export function renderizarCorreo(nombre: string): string {
  return PLANTILLA.replace('{{nombre}}', () => nombre);
}
