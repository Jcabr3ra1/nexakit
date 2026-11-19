import { db } from '../db.js';
import { ErrorConflicto, ErrorNoEncontrado } from '../errores.js';
import { buscarPorCorreo } from '../repositorios/usuarios.js';
import { validarCorreo } from './usuarios.js';

export async function cambiarCorreo(id, correo) {
  const limpio = validarCorreo(correo);
  if (await buscarPorCorreo(limpio)) throw new ErrorConflicto('El correo ya está registrado');
  const { rows } = await db.query('UPDATE usuarios SET correo = $1 WHERE id = $2 RETURNING id, nombre, correo', [limpio, id]);
  if (rows.length === 0) throw new ErrorNoEncontrado(`No existe el usuario ${id}`);
  return rows[0];
}
