export interface Usuario {
  id: number;
  nombre: string;
}

const usuarios = new Map<number, Usuario>();
let siguienteId = 1;

/** Crea un usuario y devuelve su id numérico, consecutivo desde 1. */
export function crearUsuario(nombre: string): number {
  const usuario = { id: siguienteId++, nombre };
  usuarios.set(usuario.id, usuario);
  return usuario.id;
}

/**
 * Busca un usuario por su identificador.
 * @returns el usuario, o `null` si no existe.
 */
export function buscarUsuario(id: number): Usuario | null {
  return usuarios.get(id) ?? null;
}

/**
 * Devuelve los usuarios ordenados por nombre.
 * @param limite cuántos devolver como mucho; 50 por defecto.
 */
export function listarUsuarios({ limite = 50 } = {}): Usuario[] {
  return [...usuarios.values()].sort((a, b) => a.nombre.localeCompare(b.nombre)).slice(0, limite);
}

/** Borra el usuario definitivamente. */
export function eliminarUsuario(id: number): void {
  usuarios.delete(id);
}
