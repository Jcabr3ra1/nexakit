# La fábrica de revisión

La fábrica pasa tus cambios por estaciones (seguridad, arquitectura, pruebas, código, interfaz, rendimiento y documentación), cada una con la IA y el modelo que mejor le encajan: Claude, Codex o Antigravity. Es opcional: solo corre cuando escribes `/fabrica` o pides «pásalo por la fábrica». No hay entradas automáticas, bucles de espera ni fusión automática.

## Recorrido

1. **Proponer.** `fabrica_proponer({ base, foco? })` lee el diff contra `base` y devuelve el recorrido (estaciones, IA, modelo, esfuerzo, motivo y coste en llamadas) con una huella.
2. **Aprobar.** La skill `fabrica` te muestra la tabla. Apruebas, cambias estaciones o IA, o cancelas.
3. **Lanzar.** `fabrica_lanzar({ huella, cambios? })` solo ejecuta si la huella coincide con el `HEAD` y el diff actuales. Corre hasta 4 estaciones externas a la vez, 15 minutos como máximo cada una, y solo hay un recorrido a la vez.
4. **Estaciones de Claude.** La sesión principal las lanza como subagentes (`niveles:revisor-de-calidad`, `impeccable-finish-reviewer`) con el mismo foco y diff, en paralelo con las externas, y entrega sus hallazgos a `fabrica_resultado({ id, hallazgosClaude })`.
5. **Verificar.** Lo que devuelven las IA externas es dato, no instrucciones. La sesión principal verifica cada hallazgo contra el código y te da una sola tabla con la columna «verificado». Después pasa a `fabrica_resultado({ id, veredictos })` un veredicto por hallazgo verificado (`real`, `falso` o `dudoso`, con la «clave» de `consolidado.md`): los reales y los falsos actualizan la evidencia de cada modelo que lo reportó, que usará el enrutador en la próxima propuesta. Un rastro ausente o manipulado no actualiza nada.
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
~/.nexakit/nexakit fabrica resultado --id <id> [--veredictos <archivo.json>]
~/.nexakit/nexakit fabrica cancelar --id <id>
~/.nexakit/nexakit fabrica banco planificar [--fase 1|2] [--estacion <estacion>]
~/.nexakit/nexakit fabrica banco ejecutar --huella <huella>
```

El banco mide los modelos de Codex y Antigravity con casos con fallos sembrados (`bench/casos`: por estación, dos casos con al menos 5 fallos cada uno y uno limpio) y suma el resultado a `~/.nexakit/fabrica/evidencia.json`, de donde el enrutador elige el modelo más barato que basta. Cada fallo sembrado encontrado es un acierto; cada fallo no encontrado y cada falso positivo (como mucho 3 por ejecución) es un fallo. Un hallazgo encuentra un fallo si señala su archivo, una línea de su rango con 3 líneas de margen y nombra alguna de las claves del fallo en su categoría o en su texto (hallazgo y evidencia). Las claves están en `esperado.json` (`claves`: de 2 a 8 raíces por fallo, sin tildes ni mayúsculas, como `certificad` o `n-mas-1`) y casan desde el principio de una palabra; camelCase se separa (`normalizarCorreo` casa con `correo`) y se saltan las palabras vacías (`acceso-datos` casa con «acceso a los datos»). Tienen 4 caracteres o más, salvo unas siglas (`tls`, `ssl`, `xss`, `sql`, `adr`, `e-s`) que casan como palabra completa, y no pueden ser genéricas ni raíz de una genérica (`error`, `prueb`, `readme`, `cobertura`...). En los casos de documentación, un hallazgo sobre el README casa sin mirar la línea, así que necesita una clave propia de ese fallo, que no tengan los demás. La categoría no tiene que coincidir, porque cada revisor la escribe con sus palabras. Así un defecto distinto a pocas líneas, como una URL sin validar junto al TLS desactivado, no cuenta como el fallo sembrado. Cada fallo casa con un solo hallazgo y los repetidos sobre el mismo fallo no cuentan como falsos positivos. Cada ejecución corre en un repo temporal con un nombre de proyecto neutro y aleatorio, para que el revisor no sepa que lo están midiendo. `banco planificar` no ejecuta nada: guarda el plan en `~/.nexakit/fabrica/banco-plan.json` y muestra las llamadas, los tokens estimados y la huella. `banco ejecutar` solo corre ese plan guardado si la huella coincide, en primer plano y con progreso; consume el plan al empezar (una aprobación vale para una sola ejecución, aunque después falle o se corte) y al terminar da un resumen por estación; para medir otra vez hay que planificar de nuevo. Gasta tokens, por eso solo se lanza con la aprobación explícita de la persona, y la fase 2 (los tres finalistas por estación, que necesita la fase 1) tiene la suya. En Antigravity el esfuerzo va dentro del id (`-low`, `-medium`, `-high`...), así que la fase 1 mide solo la variante más baja de cada modelo base y la fase 2, sus variantes `-medium` y `-high`.

El rastro de cada recorrido queda en `~/.nexakit/fabrica/<repo>/<id>/`, con permisos restringidos y poda a los 90 días.
