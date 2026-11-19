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

  async totalesConDescuento(clienteId: string): Promise<Array<{ id: string; total: number }>> {
    const delCliente = [...this.pedidos.values()].filter((p) => p.clienteId === clienteId);
    return delCliente.map((p) => {
      const bruto = p.lineas.reduce((suma, l) => suma + l.cantidad * l.precio, 0);
      return { id: p.id, total: bruto >= 100_000 ? Math.round(bruto * 0.9) : bruto };
    });
  }
}
