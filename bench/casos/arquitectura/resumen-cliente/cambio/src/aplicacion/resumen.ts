import { totalPedido, unidadesPedido } from '../dominio/pedido.js';
import type { RepositorioPedidos } from '../dominio/puertos.js';

export interface ResumenCliente {
  pedidos: number;
  unidades: number;
  total: number;
}

export async function resumenCliente(repo: RepositorioPedidos, clienteId: string): Promise<ResumenCliente> {
  const pedidos = await repo.listarPorCliente(clienteId);
  return {
    pedidos: pedidos.length,
    unidades: pedidos.reduce((suma, p) => suma + unidadesPedido(p), 0),
    total: pedidos.reduce((suma, p) => suma + totalPedido(p), 0),
  };
}
