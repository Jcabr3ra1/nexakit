export function conIva(base: number, tasa = 0.19): number {
  return Math.round(base * (1 + tasa) * 100) / 100;
}
