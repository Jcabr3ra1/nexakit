import type { Pedido } from './pedido.js';

export interface RepositorioPedidos {
  guardar(pedido: Pedido): Promise<void>;
  buscar(id: string): Promise<Pedido | undefined>;
  listarPorCliente(clienteId: string): Promise<Pedido[]>;
}
