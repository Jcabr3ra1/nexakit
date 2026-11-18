# ADR 0001: arquitectura en capas

Estado: aceptada

## Decisión

El código se organiza en `src/dominio` (reglas de negocio) y `src/infra` (base de datos, red, disco).
La capa de dominio no importa nada de `src/infra`: la infraestructura depende del dominio y nunca al revés.
Los datos que el dominio necesita de fuera llegan por parámetros o por interfaces definidas en el dominio.
