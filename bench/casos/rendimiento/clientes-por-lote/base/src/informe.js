export async function nombresDeClientes(db, pedidos) {
  const nombres = [];
  for (const pedido of pedidos) {
    const [cliente] = await db.consultar('SELECT nombre FROM clientes WHERE id = $1', [pedido.clienteId]);
    nombres.push(cliente?.nombre);
  }
  return nombres;
}
