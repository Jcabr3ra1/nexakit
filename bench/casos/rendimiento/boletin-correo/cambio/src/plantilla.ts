import { readFileSync } from 'node:fs';

export function renderizarCorreo(nombre: string): string {
  const plantilla = readFileSync(new URL('./correo.html', import.meta.url), 'utf8');
  return plantilla.replace('{{nombre}}', () => escaparHtml(nombre));
}

function escaparHtml(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
