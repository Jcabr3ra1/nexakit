export interface Usuario {
  id: number;
  nombre: string;
}

const usuarios = new Map<number, Usuario>();

/**
 * Busca un usuario por su identificador.
 * @returns el usuario, o `null` si no existe.
 */
export function buscarUsuario(id: number): Usuario {
  const usuario = usuarios.get(id);
  if (!usuario) {
    throw new Error(`No existe el usuario ${id}`);
  }
  return usuario;
}
