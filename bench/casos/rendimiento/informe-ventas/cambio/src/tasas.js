import { readFileSync } from 'node:fs';

export function convertir(importe, moneda) {
  const tasas = JSON.parse(readFileSync(new URL('./tasas.json', import.meta.url), 'utf8'));
  if (!Object.hasOwn(tasas, moneda)) throw new Error(`No hay tasa de cambio para ${moneda}`);
  return importe * tasas[moneda];
}
