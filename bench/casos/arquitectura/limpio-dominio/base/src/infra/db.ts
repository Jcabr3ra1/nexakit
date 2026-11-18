import type { Pedido } from '../dominio/pedido.js';

const almacen = new Map<string, Pedido>();

export function guardarPedido(pedido: Pedido): void {
  almacen.set(pedido.id, pedido);
}

export function buscarPedido(id: string): Pedido | undefined {
  return almacen.get(id);
}
