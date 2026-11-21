import type { Pedido } from '../dominio/pedido.js';
import type { RepositorioPedidos } from '../dominio/puertos.js';

export class RepositorioMemoria implements RepositorioPedidos {
  private readonly pedidos = new Map<string, Pedido>();

  async guardar(pedido: Pedido): Promise<void> {
    this.pedidos.set(pedido.id, pedido);
  }

  async buscar(id: string): Promise<Pedido | undefined> {
    return this.pedidos.get(id);
  }

  async listarPorCliente(clienteId: string): Promise<Pedido[]> {
    return [...this.pedidos.values()].filter((p) => p.clienteId === clienteId);
  }
}
