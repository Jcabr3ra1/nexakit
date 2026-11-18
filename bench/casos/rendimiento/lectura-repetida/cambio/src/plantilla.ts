import { readFileSync } from 'node:fs';

export function renderizarCorreo(nombre: string): string {
  const plantilla = readFileSync(new URL('./correo.html', import.meta.url), 'utf8');
  return plantilla.replace('{{nombre}}', nombre);
}

export function renderizarLote(nombres: string[]): string[] {
  return nombres.map((n) => renderizarCorreo(n));
}
