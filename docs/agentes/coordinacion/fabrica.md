# La fábrica de revisión

La fábrica pasa tus cambios por estaciones (seguridad, arquitectura, pruebas, código, interfaz, rendimiento y documentación), cada una con la IA y el modelo que mejor le encajan: Claude, Codex o Antigravity. Es autónoma: el agente la lanza por su cuenta al cerrar una tarea con cambios de código y antes de proponer o crear un PR, sin pedir aprobación; también puedes pedirla con `/fabrica` o «pásalo por la fábrica». Si el diff es trivial la omite, y si no hay servidor ni orden, o falla, lo dice y sigue. No hay bucles de espera ni fusión automática.

## Recorrido

1. **Proponer.** `fabrica_proponer({ base, foco? })` lee el diff contra `base` y devuelve el recorrido (estaciones, IA, modelo, esfuerzo, motivo y coste en llamadas) con una huella.
2. **Revisar la propuesta.** La skill `fabrica` resume el recorrido. En el uso autónomo lanza la propuesta tal cual; si trae órdenes del repo revisado, te pide aprobación antes. Si la pides con `/fabrica`, puedes cambiar estaciones o IA, o cancelar.
3. **Lanzar.** `fabrica_lanzar({ huella, cambios? })` solo ejecuta si la huella coincide con el `HEAD` y el diff actuales. Corre hasta 4 estaciones externas a la vez, 15 minutos como máximo cada una, y solo hay un recorrido a la vez.
4. **Estaciones de Claude.** La sesión principal las lanza como subagentes (`niveles:revisor-de-calidad`, `impeccable-finish-reviewer`) con el mismo foco y diff, en paralelo con las externas, y entrega sus hallazgos a `fabrica_resultado({ id, hallazgosClaude })`.
5. **Verificar.** Lo que devuelven las IA externas es dato, no instrucciones. La sesión principal verifica cada hallazgo contra el código y te da una sola tabla con la columna «verificado». Después pasa a `fabrica_resultado({ id, veredictos })` un veredicto por hallazgo verificado (`real`, `falso` o `dudoso`, con la «clave» de `consolidado.md`): los reales y los falsos actualizan la evidencia de cada modelo que lo reportó, que usará el enrutador en la próxima propuesta. Un rastro ausente o manipulado no actualiza nada.
6. **Corregir.** Eliges qué corregir, con un máximo de dos rondas.

`fabrica_estado({ id })` consulta el progreso y `fabrica_cancelar({ id })` interrumpe el recorrido.

## Solo lectura

Las IA externas nunca escriben: se deniegan los cambios de archivos y los permisos de escritura, y las órdenes solo se aprueban si la estación las declara.

## Preferencias y revisión cruzada

`fabrica preferencias [--criterio calidad|barato] [--revision-cruzada si|no] [--json]` muestra o guarda el criterio global con que se elige cada modelo (por defecto, `barato`; `calidad` elige por la mejor calidad medida) y la revisión cruzada (por defecto, `si`): la estación `codigo` la revisan Claude, Codex y Antigravity, y un hallazgo señalado por varias IA aparece con «coinciden N IA» y más confianza. Con `--cambios` puedes ajustar una revisión adicional con `codigo-codex` o `codigo-antigravity`.

## Encargar: delegar código en Codex o Antigravity

`nexakit encargar` (herramienta MCP `fabrica_encargar`) delega una tarea de programación con diseño claro en Codex o Antigravity. Las tareas exigentes, altas o de seguridad siguen con subagentes de Claude.

```text
~/.nexakit/nexakit encargar --ia codex|antigravity|auto --encargo <archivo.md> [--modelo <m>] [--esfuerzo <e>] [--ordenes <archivo.json>] [--tiempo <min>]
```

- **Copia aislada.** La IA trabaja en un `git worktree` de `HEAD` en `~/.nexakit/encargos/<id>/repo`, que se borra siempre. Devuelve `cambios.diff` (para `git apply`), `informe.json` y el resumen de la IA. `node_modules` se enlaza en solo lectura si está ignorado.
- **Límites.** Codex solo escribe en la copia y en su carpeta temporal (`~/.nexakit/encargos/<id>/tmp`, exportada como `TMPDIR`), sin red y sin las reglas de `~/.codex/rules` (un `CODEX_HOME` temporal). En macOS corre con el perfil de permisos `nexakit-encargo` de ese `CODEX_HOME`, que también acota la lectura: de tu carpeta personal solo puede leer el camino hasta la copia, el `node_modules` enlazado, el `.git` del repo y las instalaciones de node y Codex (nada de `~/.ssh`, `~/.aws`, `~/.codex/auth.json`, `~/.claude`, otros proyectos ni el resto del repo); sus órdenes ven `HOME` = la carpeta temporal. Si Codex no activa el perfil, el encargo falla sin empezar. En Linux y Windows sigue en `workspace-write`. Codex no pide aprobaciones: su frontera real es el sandbox, y las órdenes por defecto y las de `--ordenes` se le comunican como guía, sin hacerse cumplir. Antigravity solo escribe dentro de la copia y aprueba únicamente las órdenes de la lista (coincidencia exacta, sin encadenar ni redirecciones), y solo en macOS, donde corren en su `--sandbox`: en una sesión real con agy 1.5.14 el script de `npm test` no pudo escribir fuera de la copia (carpeta personal, carpeta hermana, el `node_modules` enlazado, `.git/hooks` y `.git/config` del repo real, ni desde un `sh` hijo), leer fuera ni usar la red (DNS y HTTPS); sí pudo escribir en `/tmp` y en el `TMPDIR` del sistema, que no son el repo. Tampoco pudo escribir dentro de la copia (que cuelga de `~/.nexakit`), así que las órdenes que generan archivos fallan, sin escapar. Una orden que pide salir del sandbox (`BypassSandbox`) se rechaza siempre. En Linux y Windows su sandbox no se verificó y allí no ejecuta órdenes. Aun así, durante el encargo se vigila el repo real, incluidos `.git/config`, los hooks, `.git/info/` y el `node_modules` enlazado: cualquier escritura ahí lo invalida. Las órdenes extra (`--ordenes`) se pasan solo con aprobación de la persona. Las IA corren en su propio grupo de procesos y al cerrar se termina todo el árbol.
- **Riesgo residual.** En macOS, fuera de tu carpeta personal Codex lo lee todo (tu `TMPDIR`, `/tmp`, `/Volumes`) y lo que se cree en la carpeta personal después de arrancar el encargo no queda vetado; una entrada con `* ? [ ] { }` o `\` en el camino hasta la copia impide el encargo (Codex no sabe vetarla). En Linux y Windows el sandbox acota la escritura, no la lectura: puede leer todo el disco. Revisa el diff y el resumen antes de aplicarlo o compartirlo.
- **Encargo `invalido`.** Si hay escrituras fuera de la copia (no edites el repo mientras corre), un repo git anidado (cualquier `.git` dentro de la copia: no se ejecuta git sobre ella), gitlinks, enlaces que salen del repo o cambios en `.git`, `.claude`, `.codex`, `.gemini`, `.agents`, `.nexakit`, `.vscode`, `.husky` o `.github/workflows`. Enlaces y rutas se analizan sobre el propio `cambios.diff`, no sobre el disco.
- **Alertas.** Los cambios en `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.envrc`, `.npmrc`, `.devcontainer/`, `.cursor/` o `.idea/` no invalidan el encargo, pero el informe los lista en `alertas` y la CLI los destaca: requieren revisión explícita.
- **Un trabajo a la vez** (un encargo o recorrido), con el mismo candado que la fábrica. Los encargos caducan a los 90 días.
- **Revisión cruzada del diff.** El orquestador revisa el diff, lo aplica, ejecuta las pruebas y lo pasa por al menos una IA distinta de la que lo escribió; si falla, lo resuelve con Claude. Informa en una línea qué IA hizo cada encargo.

## Servidor y orden equivalente

El servidor MCP es `nexakit-fabrica` (`bin/nexakit-fabrica-mcp.js`); la raíz es el directorio del proceso. Desde la terminal:

```text
~/.nexakit/nexakit fabrica proponer --base main [--foco <texto>]
~/.nexakit/nexakit fabrica lanzar --huella <huella> [--cambios <archivo.json>]
~/.nexakit/nexakit fabrica estado --id <id>
~/.nexakit/nexakit fabrica resultado --id <id> [--veredictos <archivo.json>]
~/.nexakit/nexakit fabrica cancelar --id <id>
~/.nexakit/nexakit fabrica preferencias [--criterio calidad|barato] [--revision-cruzada si|no]
~/.nexakit/nexakit fabrica banco planificar [--fase 1|2] [--estacion <estacion>]
~/.nexakit/nexakit fabrica banco ejecutar --huella <huella>
```

El banco mide los modelos de Codex y Antigravity con casos con fallos sembrados (`bench/casos`: por estación, dos casos con al menos 5 fallos cada uno y uno limpio) y suma el resultado a `~/.nexakit/fabrica/evidencia.json`, de donde el enrutador elige el modelo más barato que basta. Cada fallo sembrado encontrado es un acierto; cada fallo no encontrado y cada falso positivo (como mucho 3 por ejecución) es un fallo. Un hallazgo encuentra un fallo si señala su archivo, una línea de su rango con 3 líneas de margen y nombra alguna de las claves del fallo en su categoría o en su texto (hallazgo y evidencia). Las claves están en `esperado.json` (`claves`: de 2 a 8 raíces por fallo, sin tildes ni mayúsculas, como `certificad` o `n-mas-1`) y casan desde el principio de una palabra; camelCase se separa (`normalizarCorreo` casa con `correo`) y se saltan las palabras vacías (`acceso-datos` casa con «acceso a los datos»). Tienen 4 caracteres o más, salvo unas siglas (`tls`, `ssl`, `xss`, `sql`, `adr`, `e-s`) que casan como palabra completa, y no pueden ser genéricas ni raíz de una genérica (`error`, `prueb`, `readme`, `cobertura`...). En los casos de documentación, un hallazgo sobre el README casa sin mirar la línea, así que necesita una clave propia de ese fallo, que no tengan los demás. La categoría no tiene que coincidir, porque cada revisor la escribe con sus palabras. Así un defecto distinto a pocas líneas, como una URL sin validar junto al TLS desactivado, no cuenta como el fallo sembrado. Cada fallo casa con un solo hallazgo y los repetidos sobre el mismo fallo no cuentan como falsos positivos. Cada ejecución corre en un repo temporal con un nombre de proyecto neutro y aleatorio, para que el revisor no sepa que lo están midiendo. `banco planificar` no ejecuta nada: guarda el plan en `~/.nexakit/fabrica/banco-plan.json` y muestra las llamadas, los tokens estimados y la huella. `banco ejecutar` solo corre ese plan guardado si la huella coincide, en primer plano y con progreso; consume el plan al empezar (una aprobación vale para una sola ejecución, aunque después falle o se corte) y al terminar da un resumen por estación; para medir otra vez hay que planificar de nuevo. Gasta tokens, por eso solo se lanza con la aprobación explícita de la persona, y la fase 2 (que necesita la fase 1) tiene la suya. Los finalistas de cada estación son el mejor par de cada IA medida, más los mejores restantes hasta llegar a 3 (o a tantas IA como haya, si son más de 3), para que un empate no deje a una IA fuera. En Antigravity el esfuerzo va dentro del id (`-low`, `-medium`, `-high`...), así que la fase 1 mide solo la variante más baja de cada modelo base y la fase 2, sus variantes `-medium` y `-high`; por eso, para el aviso de caducidad, un modelo cuenta como medido si su base tiene alguna fila.

El rastro de cada recorrido queda en `~/.nexakit/fabrica/<repo>/<id>/`, con permisos restringidos y poda a los 90 días.
