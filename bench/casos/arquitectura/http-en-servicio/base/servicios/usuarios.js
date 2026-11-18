const usuarios = [];

export async function crearUsuario(nombre, correo) {
  if (!correo.includes('@')) {
    throw new Error('Correo inválido');
  }
  const usuario = { id: usuarios.length + 1, nombre, correo };
  usuarios.push(usuario);
  return usuario;
}
