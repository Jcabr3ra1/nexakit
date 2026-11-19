import { totalPedido, type Pedido } from '../dominio/pedido.js';
import type { RepositorioPedidos } from '../dominio/puertos.js';

export async function confirmarPedido(repo: RepositorioPedidos, pedido: Pedido): Promise<number> {
  if (pedido.lineas.length === 0) throw new Error('El pedido no tiene líneas');
  await repo.guardar(pedido);
  return totalPedido(pedido);
}
