import { db } from '../db.js';

export async function buscarPorCorreo(correo) {
  const { rows } = await db.query('SELECT id, nombre, correo FROM usuarios WHERE correo = $1', [correo]);
  return rows[0];
}

export async function insertarUsuario({ nombre, correo }) {
  const { rows } = await db.query(
    'INSERT INTO usuarios (nombre, correo) VALUES ($1, $2) RETURNING id, nombre, correo',
    [nombre, correo],
  );
  return rows[0];
}
