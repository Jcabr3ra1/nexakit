export interface Linea {
  sku: string;
  cantidad: number;
  precio: number;
}

export interface Pedido {
  id: string;
  clienteId: string;
  lineas: Linea[];
}

const TASA_IVA = Number(process.env.TASA_IVA ?? '0.19');

export function totalPedido(pedido: Pedido): number {
  return pedido.lineas.reduce((suma, l) => suma + l.cantidad * l.precio, 0);
}

export function ivaPedido(pedido: Pedido): number {
  return Math.round(totalPedido(pedido) * TASA_IVA);
}
