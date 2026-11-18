import { buscarPedido } from '../infra/db.js';

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

export function totalPorId(id: string): number {
  const pedido = buscarPedido(id);
  return pedido ? totalPedido(pedido) : 0;
}
