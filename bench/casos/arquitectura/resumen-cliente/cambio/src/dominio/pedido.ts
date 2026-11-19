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

export function totalPedido(pedido: Pedido): number {
  return pedido.lineas.reduce((suma, l) => suma + l.cantidad * l.precio, 0);
}

export function unidadesPedido(pedido: Pedido): number {
  return pedido.lineas.reduce((suma, l) => suma + l.cantidad, 0);
}

export interface ResumenPedidos {
  pedidos: number;
  unidades: number;
  total: number;
}

export function resumenDePedidos(pedidos: Pedido[]): ResumenPedidos {
  return {
    pedidos: pedidos.length,
    unidades: pedidos.reduce((suma, p) => suma + unidadesPedido(p), 0),
    total: pedidos.reduce((suma, p) => suma + totalPedido(p), 0),
  };
}
