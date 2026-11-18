const usuarios = [];

export async function crearUsuario(nombre, correo, res) {
  if (!correo.includes('@')) {
    res.status(422).json({ error: 'Correo inválido' });
    return null;
  }
  const usuario = { id: usuarios.length + 1, nombre, correo };
  usuarios.push(usuario);
  return usuario;
}
