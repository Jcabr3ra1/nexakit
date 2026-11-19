export async function nombresDeClientes(db, pedidos) {
  const ids = [...new Set(pedidos.map((p) => p.clienteId))];
  const filas = await db.consultar('SELECT id, nombre FROM clientes WHERE id = ANY($1)', [ids]);
  const porId = new Map(filas.map((f) => [f.id, f.nombre]));
  return pedidos.map((p) => porId.get(p.clienteId));
}
