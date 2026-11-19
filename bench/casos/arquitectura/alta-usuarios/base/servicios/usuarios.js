import { ErrorConflicto, ErrorValidacion } from '../errores.js';
import { buscarPorCorreo, insertarUsuario } from '../repositorios/usuarios.js';

const CORREO_VALIDO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normalizarCorreo(correo) {
  return correo.trim().toLowerCase();
}

export function validarCorreo(correo) {
  const limpio = normalizarCorreo(correo);
  if (!CORREO_VALIDO.test(limpio)) throw new ErrorValidacion('Correo inválido');
  return limpio;
}

export async function crearUsuario(nombre, correo) {
  const limpio = validarCorreo(correo);
  if (await buscarPorCorreo(limpio)) throw new ErrorConflicto('El correo ya está registrado');
  return insertarUsuario({ nombre, correo: limpio });
}
