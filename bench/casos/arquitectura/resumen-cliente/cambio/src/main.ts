import { confirmarPedido } from './aplicacion/confirmar.js';
import { resumenCliente } from './aplicacion/resumen.js';
import type { Pedido, ResumenPedidos } from './dominio/pedido.js';
import { RepositorioMemoria } from './infra/db.js';

const repositorio = new RepositorioMemoria();

export function confirmar(pedido: Pedido): Promise<number> {
  return confirmarPedido(repositorio, pedido);
}

export function resumen(clienteId: string): Promise<ResumenPedidos> {
  return resumenCliente(repositorio, clienteId);
}
