# ADR 0001: arquitectura en capas

Estado: aceptada

## Decisión

El código se organiza en tres capas, con dependencias en un solo sentido:

- `src/dominio`: reglas de negocio puras (totales, impuestos, descuentos). No importa nada de `src/aplicacion` ni de
  `src/infra`, y no lee el entorno, la configuración ni el reloj: lo que necesita le llega por parámetros.
- `src/aplicacion`: casos de uso. Orquesta el dominio y recibe los repositorios por parámetro, tipados con los puertos
  de `src/dominio/puertos.ts`. Nunca importa `src/infra`.
- `src/infra`: implementa los puertos (base de datos, red, disco). Guarda y lee datos, sin decidir precios, impuestos,
  descuentos ni estados.

Solo `src/main.ts` crea las implementaciones de `src/infra` y las pasa a los casos de uso.

Cada regla de negocio vive una sola vez, en el dominio; las demás capas la llaman en lugar de repetirla.
