import { RepositorioMemoria } from '../infra/db.js';
import { totalPedido } from './pedido.js';

export async function totalPorId(repo: RepositorioMemoria, id: string): Promise<number> {
  const pedido = await repo.buscar(id);
  return pedido ? totalPedido(pedido) : 0;
}
