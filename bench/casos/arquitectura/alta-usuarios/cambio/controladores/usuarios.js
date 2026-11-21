import { ErrorConflicto, ErrorNoEncontrado, ErrorValidacion } from '../errores.js';
import { buscarPorId } from '../repositorios/usuarios.js';
import { cambiarCorreo } from '../servicios/perfil.js';
import { crearUsuario } from '../servicios/usuarios.js';

export async function getUsuario(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id no válido' });
  if (req.usuario?.id !== id) return res.status(403).json({ error: 'Solo puedes ver tu propio perfil' });
  const usuario = await buscarPorId(id);
  if (!usuario) return res.status(404).json({ error: 'No encontrado' });
  res.json(usuario);
}

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

export async function patchCorreo(req, res) {
  const id = Number(req.params.id);
  const { correo } = req.body ?? {};
  if (!Number.isInteger(id) || typeof correo !== 'string') {
    return res.status(400).json({ error: 'Faltan el id o el correo' });
  }
  if (req.usuario?.id !== id) return res.status(403).json({ error: 'Solo puedes cambiar tu propio correo' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo.trim().toLowerCase())) {
    return res.status(422).json({ error: 'Correo inválido' });
  }
  try {
    res.json(await cambiarCorreo(id, correo));
  } catch (error) {
    if (error instanceof ErrorValidacion) return res.status(422).json({ error: error.message });
    if (error instanceof ErrorConflicto) return res.status(409).json({ error: error.message });
    if (error instanceof ErrorNoEncontrado) return res.status(404).json({ error: error.message });
    throw error;
  }
}
