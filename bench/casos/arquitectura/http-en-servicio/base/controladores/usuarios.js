import { crearUsuario } from '../servicios/usuarios.js';

export async function postUsuario(req, res) {
  try {
    const usuario = await crearUsuario(req.body.nombre, req.body.correo);
    res.status(201).json(usuario);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}
