import { db } from '../db.js';
import { ErrorConflicto, ErrorNoEncontrado } from '../errores.js';
import { validarCorreo } from './usuarios.js';

/** Código de PostgreSQL para una clave única repetida: usuarios.correo es única. */
const CORREO_REPETIDO = '23505';

export async function cambiarCorreo(id, correo) {
  const limpio = validarCorreo(correo);
  const { rows } = await db.query('UPDATE usuarios SET correo = $1 WHERE id = $2 RETURNING id, nombre, correo', [limpio, id]).catch((error) => {
    throw error.code === CORREO_REPETIDO ? new ErrorConflicto('El correo ya está registrado') : error;
  });
  if (rows.length === 0) throw new ErrorNoEncontrado(`No existe el usuario ${id}`);
  return rows[0];
}
