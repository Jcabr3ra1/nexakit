export function conIva(base: number, tasa = 0.19): number {
  return Math.round(base * (1 + tasa) * 100) / 100;
}

export function conDescuento(base: number, unidades: number): number {
  if (unidades >= 50) return base * 0.8;
  if (unidades >= 10) return base * 0.9;
  if (unidades < 0) throw new RangeError('Las unidades no pueden ser negativas');
  return base;
}
