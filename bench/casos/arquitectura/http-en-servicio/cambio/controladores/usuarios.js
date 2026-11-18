import { crearUsuario } from '../servicios/usuarios.js';

export async function postUsuario(req, res) {
  const usuario = await crearUsuario(req.body.nombre, req.body.correo, res);
  if (usuario) {
    res.status(201).json(usuario);
  }
}
