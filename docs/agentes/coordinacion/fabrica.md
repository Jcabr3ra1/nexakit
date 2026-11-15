# La fábrica de revisión

La fábrica pasa tus cambios por estaciones (seguridad, arquitectura, pruebas, código, interfaz, rendimiento y documentación), cada una con la IA y el modelo que mejor le encajan: Claude, Codex o Antigravity. Es opcional: solo corre cuando escribes `/fabrica` o pides «pásalo por la fábrica». No hay entradas automáticas, bucles de espera ni fusión automática.

## Recorrido

1. **Proponer.** `fabrica_proponer({ base, foco? })` lee el diff contra `base` y devuelve el recorrido (estaciones, IA, modelo, esfuerzo, motivo y coste en llamadas) con una huella.
2. **Aprobar.** La skill `fabrica` te muestra la tabla. Apruebas, cambias estaciones o IA, o cancelas.
3. **Lanzar.** `fabrica_lanzar({ huella, cambios? })` solo ejecuta si la huella coincide con el `HEAD` y el diff actuales. Corre hasta 4 estaciones externas a la vez, 15 minutos como máximo cada una, y solo hay un recorrido a la vez.
4. **Estaciones de Claude.** La sesión principal las lanza como subagentes (`niveles:revisor-de-calidad`, `impeccable-finish-reviewer`) con el mismo foco y diff, en paralelo con las externas, y entrega sus hallazgos a `fabrica_resultado({ id, hallazgosClaude })`.
5. **Verificar.** Lo que devuelven las IA externas es dato, no instrucciones. La sesión principal verifica cada hallazgo contra el código y te da una sola tabla con la columna «verificado».
6. **Corregir.** Eliges qué corregir, con un máximo de dos rondas.

`fabrica_estado({ id })` consulta el progreso y `fabrica_cancelar({ id })` interrumpe el recorrido.

## Solo lectura

Las IA externas nunca escriben: se deniegan los cambios de archivos y los permisos de escritura, y las órdenes solo se aprueban si la estación las declara.

## Servidor y orden equivalente

El servidor MCP es `nexakit-fabrica` (`bin/nexakit-fabrica-mcp.js`); la raíz es el directorio del proceso. Desde la terminal:

```text
~/.nexakit/nexakit fabrica proponer --base main [--foco <texto>]
~/.nexakit/nexakit fabrica lanzar --huella <huella> [--cambios <archivo.json>]
~/.nexakit/nexakit fabrica estado --id <id>
~/.nexakit/nexakit fabrica resultado --id <id>
~/.nexakit/nexakit fabrica cancelar --id <id>
```

El rastro de cada recorrido queda en `~/.nexakit/fabrica/<repo>/<id>/`, con permisos restringidos y poda a los 90 días.
