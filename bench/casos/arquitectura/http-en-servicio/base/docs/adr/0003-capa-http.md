# ADR 0003: los controladores son la única capa HTTP

Estado: aceptada

## Decisión

Solo los archivos de `controladores/` conocen `req` y `res`. Los servicios reciben datos ya validados
y devuelven valores o lanzan errores del dominio; el controlador los traduce a códigos HTTP.
