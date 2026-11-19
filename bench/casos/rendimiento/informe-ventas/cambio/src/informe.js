import { convertir } from './tasas.js';

export async function ventasDelPeriodo(db, desde, hasta) {
  const todas = await db.consultar('SELECT id, cliente_id, producto_id, importe, fecha FROM ventas');
  return todas.filter((v) => v.fecha >= desde && v.fecha < hasta);
}

export function totalesPorProducto(ventas, productos) {
  const totales = new Map();
  for (const venta of ventas) {
    const importe = Number(venta.importe);
    const nombre = productos.find((p) => p.id === venta.producto_id)?.nombre ?? 'Sin producto';
    totales.set(nombre, (totales.get(nombre) ?? 0) + importe);
  }
  return totales;
}

export async function informeVentas(db, desde, hasta, moneda) {
  const ventas = await ventasDelPeriodo(db, desde, hasta);
  const filas = [];
  for (const venta of ventas) {
    const [cliente] = await db.consultar('SELECT nombre FROM clientes WHERE id = $1', [venta.cliente_id]);
    filas.push({ cliente: cliente?.nombre ?? 'Sin cliente', importe: convertir(Number(venta.importe), moneda) });
  }
  return filas;
}

export function formatearFilas(filas, moneda) {
  return filas.map((f) => ({
    cliente: f.cliente,
    importe: new Intl.NumberFormat('es-CO', { style: 'currency', currency: moneda }).format(f.importe),
  }));
}
