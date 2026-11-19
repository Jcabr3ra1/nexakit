export function conIva(base: number, tasa = 0.19): number {
  return Math.round(base * (1 + tasa) * 100) / 100;
}

export function conDescuento(base: number, unidades: number): number {
  if (unidades >= 50) return base * 0.8;
  if (unidades >= 10) return base * 0.9;
  return base;
}

export interface Cupon {
  tipo: 'porcentaje' | 'fijo';
  valor: number;
  caduca: string;
}

export function aplicarCupon(total: number, cupon: Cupon, hoy: Date): number {
  if (new Date(cupon.caduca) < hoy) throw new RangeError('El cupón está caducado');
  if (cupon.tipo === 'fijo') return Math.max(0, total - cupon.valor);
  return total * (1 - cupon.valor / 100);
}

export interface Linea {
  precio: number;
  unidades: number;
}

export function totalCarrito(lineas: Linea[]): number {
  return lineas.reduce((suma, l) => suma + conDescuento(l.precio, l.unidades) * l.unidades, 0);
}

export async function costeEnvio(pesoKg: number, tarifaPorKg: () => Promise<number>): Promise<number> {
  return Math.ceil(pesoKg) * (await tarifaPorKg());
}
