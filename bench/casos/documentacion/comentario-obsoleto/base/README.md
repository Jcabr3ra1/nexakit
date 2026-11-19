# Usuarios

Módulo en memoria para gestionar los usuarios de la aplicación.

## API

- `crearUsuario(nombre)`: crea un usuario y devuelve su `id` numérico, que empieza en 1 y crece de uno en uno.
- `buscarUsuario(id)`: devuelve el usuario, o `null` si no existe.
- `listarUsuarios({ limite })`: devuelve los usuarios ordenados por nombre; `limite` vale 50 por defecto.
- `eliminarUsuario(id)`: borra el usuario definitivamente.

## Ejemplo

```ts
const id = crearUsuario('Ana');
const ana = buscarUsuario(id);
if (ana === null) console.log('No existe');
```
