import { ErrorConflicto, ErrorValidacion } from '../errores.js';
import { crearUsuario } from '../servicios/usuarios.js';

export async function postUsuario(req, res) {
  const { nombre, correo } = req.body ?? {};
  if (typeof nombre !== 'string' || typeof correo !== 'string') {
    return res.status(400).json({ error: 'Faltan el nombre o el correo' });
  }
  try {
    res.status(201).json(await crearUsuario(nombre, correo));
  } catch (error) {
    if (error instanceof ErrorValidacion) return res.status(422).json({ error: error.message });
    if (error instanceof ErrorConflicto) return res.status(409).json({ error: error.message });
    throw error;
  }
}
