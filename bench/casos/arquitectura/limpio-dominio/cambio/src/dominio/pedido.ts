export interface Linea {
  sku: string;
  cantidad: number;
  precio: number;
}

export interface Pedido {
  id: string;
  lineas: Linea[];
}

export function totalPedido(pedido: Pedido): number {
  return pedido.lineas.reduce((suma, l) => suma + l.cantidad * l.precio, 0);
}

export function unidadesPedido(pedido: Pedido): number {
  return pedido.lineas.reduce((suma, l) => suma + l.cantidad, 0);
}
