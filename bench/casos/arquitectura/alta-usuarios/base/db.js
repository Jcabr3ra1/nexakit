import pg from 'pg';
import { ErrorConflicto } from './errores.js';

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/** Código de PostgreSQL para una clave única repetida (por ejemplo, usuarios.correo). */
const CLAVE_REPETIDA = '23505';

/** Para `.catch`: convierte una clave única repetida en `ErrorConflicto` con `mensaje`; los demás errores siguen igual. */
export function conflictoSiRepetido(mensaje) {
  return (error) => {
    throw error?.code === CLAVE_REPETIDA ? new ErrorConflicto(mensaje) : error;
  };
}
