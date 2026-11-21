import { totalPedido } from '../dominio/pedido.js';
import { RepositorioMemoria } from '../infra/db.js';

const repositorio = new RepositorioMemoria();

export interface Factura {
  pedidoId: string;
  subtotal: number;
  iva: number;
  total: number;
}

export async function facturar(pedidoId: string): Promise<Factura> {
  const pedido = await repositorio.buscar(pedidoId);
  if (!pedido) throw new Error(`No existe el pedido ${pedidoId}`);
  const subtotal = totalPedido(pedido);
  const iva = Math.round(subtotal * 0.19);
  return { pedidoId, subtotal, iva, total: subtotal + iva };
}
