# ADR 0003: capas del servidor

Estado: aceptada

## Decisión

Las dependencias van en un solo sentido: `controladores/` → `servicios/` → `repositorios/` → `db.js`.

- Solo `controladores/` conocen `req`, `res` y los códigos HTTP. Comprueban la forma de la petición (que lleguen los
  campos y sean texto o números) y traducen los errores de `errores.js` a códigos HTTP. No contienen reglas de negocio
  ni llaman a `repositorios/`.
- `servicios/` aplican las reglas de negocio (qué correo es válido, qué límites tiene cada cuenta) y lanzan los errores
  de `errores.js`. No usan `db.js`: leen y escriben a través de `repositorios/`.
- `repositorios/` son los únicos que usan `db.js`. Solo guardan y leen; no deciden nada de negocio y no importan
  nada de `servicios/` ni de `controladores/`.
