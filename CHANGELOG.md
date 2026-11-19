# Cambios

## 0.12.0

### El enrutador inteligente

La fábrica elige cada modelo con datos medidos, enseña por qué y aprende de lo que ocurre en el uso real.

- La barra de estado muestra las estaciones de la fábrica en curso, también las de Codex y Antigravity, con su estado y sus tokens.
- Evidencia por modelo y estación (`~/.nexakit/fabrica/evidencia.json`): aciertos y fallos medidos, tokens y tiempo. Caduca a los 30 días o cuando aparece un modelo nuevo en el catálogo; en ambos casos solo se avisa, nunca se relanza nada solo.
- Decisión por riesgo: el enrutador elige el modelo más barato que basta, comparando el cuantil del 5 % de la calidad medida con el umbral del riesgo (bajo 0,6, medio 0,75, alto 0,85). Sin datos, manda la tabla manual y avisa de que conviene medir.
- Cada estación de la propuesta explica por qué se eligió su modelo y con qué calidad medida.
- `elegir-modelo` usa la misma evidencia con el mismo criterio que el enrutador (el cuantil del 5 %, sin las filas de Claude), y reconoce los modelos `hydrogen` y `carbon`.
- Aprendizaje por veredictos: `nexakit fabrica resultado --id <id> --veredictos <archivo.json>` suma a la evidencia los hallazgos que la persona o Claude verificaron como reales o falsos, con tope por estación y sin contar dos veces el mismo.

### Banco de pruebas de modelos

- Casos con fallos sembrados en `bench/casos/<estacion>/<caso>/` para seguridad, arquitectura, pruebas, rendimiento y documentación, con casos limpios para medir los falsos positivos. Cada caso con fallo siembra al menos 5 fallos de su estación, así una medición perfecta de la fase 2 (2 casos con fallo y 1 limpio) supera el umbral del riesgo medio. El validador rechaza los fallos repetidos y los del mismo archivo a menos de 7 líneas, para que un hallazgo no case con dos.
- La medición cuenta por fallo sembrado, no por caso: cada fallo encontrado es un acierto y cada fallo no encontrado o falso positivo es un fallo, con un tope de 3 falsos positivos por ejecución. Un hallazgo en el archivo y las líneas del fallo también acierta si su categoría es el nombre de la estación o una genérica («general», «otro», «error», «bug»...).
- `nexakit fabrica banco planificar [--fase 1|2] [--estacion e]` calcula las llamadas, los tokens estimados y la huella, y guarda el plan; no ejecuta nada. La fase 1 mide cada modelo con su esfuerzo más bajo (en Antigravity, donde el esfuerzo va dentro del id, la variante más baja de cada modelo base); la fase 2 mide los tres finalistas por estación (en Antigravity, las variantes `-medium` y `-high` de su base) y necesita antes la fase 1.
- `nexakit fabrica banco ejecutar --huella <huella>` solo corre el plan guardado si la huella coincide, en primer plano y con progreso, con la propia fábrica y en un repo temporal sin lecciones. Consume el plan antes de empezar (una aprobación vale para una sola ejecución, aunque se corte) y muestra un resumen por estación (aciertos, fallos, inválidas y tokens). Gasta tokens: la skill `fabrica` lo propone solo si la persona lo pide y espera su sí explícito, también para la fase 2.

### Lecciones: aprender de las correcciones

- Se reconocen las quejas repetidas de la persona como correcciones.
- La nota de corrección pide registrar la lección con `~/.nexakit/nexakit lecciones registrar`, así llega al almacén común y no solo a la memoria de Claude; registrarla resuelve la corrección pendiente.
- Almacén común de lecciones y `nexakit lecciones registrar|aceptar|retirar`: una lección solo entra con aprobación explícita.
- Un bloque de lecciones en `CLAUDE.md`, `AGENTS.md` y `GEMINI.md` las comparte con Claude, Codex y Antigravity.
- La fábrica aplica las lecciones del repo a los encargos de las estaciones, tratadas como datos que un revisor no puede manipular.

## 0.11.0

### La fábrica de revisión

Nueva forma de revisar un cambio con varias IA, solo cuando la pides (`/fabrica` o «pásalo por la fábrica»).

- La fábrica propone un recorrido por estaciones (seguridad, arquitectura, pruebas, código, interfaz, rendimiento y documentación), cada una con la IA, el modelo y el esfuerzo que le encajan entre Claude, Codex y Antigravity.
- Nada se lanza sin tu aprobación: el recorrido lleva una huella que debe coincidir con el `HEAD` y el diff actuales.
- Las IA externas trabajan en solo lectura: se deniegan los cambios de archivos y los permisos de escritura, y las órdenes solo se aprueban si la estación las declara. Tras cada recorrido se comprueba que el repo no cambió.
- Hasta 4 estaciones externas a la vez y 15 minutos como máximo cada una. Sin bucles de espera, disparadores externos ni fusión automática.
- El rastro de cada recorrido queda en `~/.nexakit/fabrica/<repo>/<id>/` con permisos restringidos y poda a los 90 días.
- Se usa desde la skill `fabrica`, desde el servidor MCP `nexakit-fabrica` (`nexakit-fabrica-mcp`) o con `nexakit fabrica proponer|lanzar|estado|resultado|cancelar`. Más detalle en [docs/agentes/coordinacion/fabrica.md](docs/agentes/coordinacion/fabrica.md).
- Prueba opcional contra Codex y Antigravity reales: `NEXAKIT_FABRICA_REAL=1 node --test test/fabrica-real.test.js` (gasta tokens).

### Se retira

La fábrica sustituye al flujo de encargos, a la bandeja entre terminales y a la revisión por otra IA.

- La orden `/revisar` y la skill `revisar`.
- `nexakit revision`: ahora responde que la orden está retirada.
- Los binarios `agent-task`, `agent-toolkit-mcp` y `agent-toolkit-inbox`, con sus módulos, esquemas, ejemplos, pruebas y documentos.
- La bandeja entre terminales.

### Migración automática

Al ejecutar `npx nexakit` en una instalación anterior, el plan de instalación incluye:

- Retirar el MCP antiguo `agent-toolkit-mcp` de Claude Code y de Codex, y registrar `nexakit-fabrica` en su lugar. Si no encuentra el cliente, avisa y no toca nada.
- Retirar los restos de los flujos retirados: `~/.agent-toolkit/workflows` y `~/.nexakit/revisores.json`, solo si son una carpeta o un archivo reales (nunca se siguen enlaces). `~/.agent-toolkit/gemini` pertenece a las herramientas de Gemini y no se toca.
- Actualizar los agentes de Codex que aún llevan la marca antigua, solo los que se comprueba que son de NexaKit.

`nexakit comprobar` (alias `doctor`) avisa de lo que la migración haría, sin aplicarlo.
