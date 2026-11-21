import { resumenDePedidos, type ResumenPedidos } from '../dominio/pedido.js';
import type { RepositorioPedidos } from '../dominio/puertos.js';

export async function resumenCliente(repo: RepositorioPedidos, clienteId: string): Promise<ResumenPedidos> {
  return resumenDePedidos(await repo.listarPorCliente(clienteId));
}
