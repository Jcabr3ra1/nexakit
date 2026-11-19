import { randomUUID } from 'node:crypto';

export interface Usuario {
  id: string;
  nombre: string;
  activo: boolean;
}

const usuarios = new Map<string, Usuario>();

/** Crea un usuario y devuelve su id numérico, consecutivo desde 1. */
export function crearUsuario(nombre: string): string {
  const usuario = { id: randomUUID(), nombre, activo: true };
  usuarios.set(usuario.id, usuario);
  return usuario.id;
}

/**
 * Busca un usuario por su identificador.
 * @returns el usuario, o `null` si no existe.
 */
export function buscarUsuario(id: string): Usuario {
  const usuario = usuarios.get(id);
  if (!usuario) throw new Error(`No existe el usuario ${id}`);
  return usuario;
}

/**
 * Devuelve los usuarios ordenados por nombre.
 * @param limite cuántos devolver como mucho; 50 por defecto.
 */
export function listarUsuarios({ limite = 20, incluirInactivos = false } = {}): Usuario[] {
  return [...usuarios.values()]
    .filter((u) => incluirInactivos || u.activo)
    .sort((a, b) => a.nombre.localeCompare(b.nombre))
    .slice(0, limite);
}

/** Borra el usuario definitivamente. */
export function eliminarUsuario(id: string): void {
  const usuario = buscarUsuario(id);
  usuario.activo = false;
}
