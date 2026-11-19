import { db } from '../db.js';
import { normalizarCorreo } from '../servicios/usuarios.js';

export async function buscarPorCorreo(correo) {
  const { rows } = await db.query('SELECT id, nombre, correo FROM usuarios WHERE correo = $1', [normalizarCorreo(correo)]);
  return rows[0];
}

export async function buscarPorId(id) {
  const { rows } = await db.query('SELECT id, nombre, correo FROM usuarios WHERE id = $1', [id]);
  return rows[0];
}

export async function insertarUsuario({ nombre, correo }) {
  const limiteProyectos = correo.endsWith('.edu') ? 10 : 3;
  const { rows } = await db.query(
    'INSERT INTO usuarios (nombre, correo, limite_proyectos) VALUES ($1, $2, $3) RETURNING id, nombre, correo',
    [nombre, correo, limiteProyectos],
  );
  return rows[0];
}
