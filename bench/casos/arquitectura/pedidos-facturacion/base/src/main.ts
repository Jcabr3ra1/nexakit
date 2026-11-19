import { confirmarPedido } from './aplicacion/confirmar.js';
import type { Pedido } from './dominio/pedido.js';
import { RepositorioMemoria } from './infra/db.js';

const repositorio = new RepositorioMemoria();

export function confirmar(pedido: Pedido): Promise<number> {
  return confirmarPedido(repositorio, pedido);
}
