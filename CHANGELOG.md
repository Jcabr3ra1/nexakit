# Cambios

## 0.13.0

### Encargos a Codex y Antigravity y revisión cruzada

- `nexakit encargar` (herramienta MCP `fabrica_encargar`) delega una tarea de programación en Codex o Antigravity. La IA trabaja en una copia aislada (un `git worktree` de `HEAD` en `~/.nexakit/encargos/<id>/repo`, que se borra siempre) y devuelve `cambios.diff` listo para `git apply` e `informe.json`. Si `node_modules` está ignorado, se enlaza en solo lectura. Los encargos caducan a los 90 días.
- Límites: Codex solo escribe en la copia y en su carpeta temporal `~/.nexakit/encargos/<id>/tmp` (que exporta como `TMPDIR`), sin red y sin las reglas de `~/.codex/rules` (con un `CODEX_HOME` temporal). En macOS también se acota su lectura con el perfil de permisos `nexakit-encargo` de ese `CODEX_HOME`: de la carpeta personal solo lee el camino hasta la copia, el `node_modules` enlazado, el `.git` del repo y las instalaciones de node y Codex (dentro de la carpeta personal, solo la carpeta del ejecutable o del paquete y su `lib`, no `~/.cargo` ni `~/.bun` enteros; no `~/.ssh`, `~/.aws`, `~/.codex/auth.json`, `~/.claude`, otros proyectos ni el resto del repo), y sus órdenes ven `HOME` = la carpeta temporal; si Codex no activa el perfil, el encargo falla sin empezar. En Linux y Windows sigue en `workspace-write`. Codex no pide aprobaciones, así que su frontera real es el sandbox: las órdenes por defecto y las de `--ordenes` se le comunican como guía, no se hacen cumplir. Antigravity solo escribe dentro de la copia y no ejecuta órdenes: están desactivadas en todas las plataformas y las pruebas las ejecuta el orquestador. Con agy 1.5.14 y 1.5.16 en macOS, `agy acp --sandbox` monta la carpeta de la sesión en solo lectura para las órdenes, esté donde esté (bajo `~/.nexakit`, en una carpeta no oculta y bajo el `TMPDIR`, en worktree y en repo normal, y con `--add-dir`, `additionalDirectories` o un proyecto que la declara), así que las que generan archivos fallan; en 11 sesiones reales el modelo omitió `BypassSandbox` y se rechazaban igualmente; y las órdenes con sandbox pueden escribir en `/tmp` y en el `TMPDIR`, donde vive la carpeta aislada de `--gemini-dir` (configuración de agy): un riesgo sin contrapartida. La lógica de lista exacta, `BypassSandbox: false`, versión y plataforma sigue en el conector detrás de la opción inyectable `ordenesActivas`, para pruebas y para reactivarla. Riesgo conocido menor: agy 1.5.16 carga las skills de `~/.agents/skills` aunque se use `--gemini-dir` (son skills de la propia persona). Una petición con la misma clave repetida con otra capitalización (`cwd` y `Cwd`) se rechaza. Las órdenes extra se pasan solo con aprobación de la persona.
- Riesgo residual: en macOS, fuera de la carpeta personal Codex lo lee todo (`TMPDIR`, `/tmp`, `/Volumes`) y lo creado en ella después de arrancar no queda vetado; una entrada con `* ? [ ] { }` o `\` en el camino hasta la copia impide el encargo. En Linux y Windows el sandbox acota la escritura, no la lectura: puede leer todo el disco. Revisa el diff y el resumen antes de aplicarlo o compartirlo.
- El encargo queda `invalido` si hay escrituras fuera de la copia (no edites el repo mientras corre), un repo git anidado (`.git` dentro de la copia: no se ejecuta git sobre ella), gitlinks, enlaces que salen del repo o cambios en `.git`, `.claude`, `.codex`, `.gemini`, `.agents`, `.nexakit`, `.vscode`, `.husky` o `.github/workflows`. Enlaces y rutas se analizan sobre el propio `cambios.diff`, no sobre el disco. Los cambios en `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.envrc`, `.npmrc`, `.devcontainer/`, `.cursor/` o `.idea/` no lo invalidan, pero salen en `alertas` para revisarlos a mano. Las IA corren en su propio grupo de procesos y al cerrar se termina todo el árbol. Un trabajo a la vez (un encargo o recorrido), con el mismo candado que la fábrica.
- La vigilancia del repo real durante un encargo (y durante un recorrido de la fábrica) cubre también `.git/config` y `config.worktree`, los hooks (los de `core.hooksPath` y los de la carpeta común, con su contenido y su modo) y `.git/info/` (si alguno es un enlace se anota su destino y se vigila el destino resuelto, sin seguir los enlaces de dentro), y en `node_modules` la fecha de cada entrada de primer nivel (y de los paquetes con ámbito), el `package.json` de cada paquete y los archivos como `.package-lock.json`: escribir ahí invalida el encargo.
- `nexakit fabrica preferencias [--criterio calidad|barato] [--revision-cruzada sí|no] [--json]` guarda cómo se elige el modelo de cada estación (por defecto, barato) y si la revisión cruzada está activa (por defecto, sí).
- La estación `codigo` se revisa con Claude, Codex y Antigravity; un hallazgo que señalan varias IA aparece como «coinciden N IA» y sube su confianza.
- Regla de orquestación nueva en CLAUDE.md, AGENTS.md y GEMINI.md: las tareas ligeras o normales con diseño claro se delegan primero con `fabrica_encargar`; el orquestador revisa el diff, lo aplica, ejecuta las pruebas e integra, y si falla lo resuelve con Claude. La revisión del diff incluye al menos una IA distinta de la que lo escribió. Las instalaciones con el bloque anterior se actualizan solas al volver a ejecutar `npx nexakit`.
- La skill `fabrica`, el README, la guía de comandos y la guía de la fábrica documentan los encargos, las preferencias y la revisión cruzada.
- `nexakit-modelo` 0.5.9: en la app de escritorio, cuando la barra sugiere delegar, `→ delega: nivel-x` es un botón que envía a la sesión la instrucción de delegar tu mensaje anterior (ligero y normal, con un encargo a Codex o Antigravity; exigente y alto, directo al subagente de nivel). Solo aparece en el escritorio, sin turno en curso de la sesión principal y con la caja vacía o con ese mismo texto; no se puede pulsar dos veces, vuelve si se aborta el turno de la delegación y, si el envío falla, avisa para reintentar. En la terminal sigue siendo texto.
- `nexakit-modelo` 0.5.9 también veta el subagente `niveles:nivel-normal` lanzado por la sesión principal (no el de los subagentes) cuando existe `fabrica_encargar`: responde «Primero encarga esta implementación con fabrica_encargar (Codex o Antigravity)…» y solo lo deja pasar si la descripción o el prompt llevan `[sin encargo]` (encargo imposible o ya fallido). Ligero, exigente, alto y los demás agentes no se vetan.
- El bloque de instrucciones deja de mandar «normal para implementar» a subagentes de Claude: implementar con diseño claro y los cambios mecánicos de código se hacen primero con `fabrica_encargar`; `niveles:nivel-normal` solo si el encargo no es posible (repo sin commits, otro encargo o recorrido en marcha, sin conector) o ya falló. Los encargos van de uno en uno y no se sustituyen por subagentes para paralelizar (mientras corre uno, se prepara el siguiente o se revisa). Las instalaciones con el bloque anterior se actualizan solas al volver a ejecutar `npx nexakit`.

## 0.12.3

### La fábrica se usa por su cuenta

- La fábrica (revisión por estaciones con Claude, Codex y Antigravity) ya no espera a que la persona la pida: el orquestador la lanza al cerrar una tarea con cambios de código y siempre antes de proponer o crear un PR, con `fabrica_proponer` y `fabrica_lanzar` con la huella de esa propuesta. Después lee el resultado, corrige los hallazgos reales y registra los veredictos. Si el diff es trivial la omite; si no hay servidor ni orden, o falla, lo dice en una línea y sigue. Sigue siendo de solo lectura, con huella obligatoria y un recorrido a la vez, sin encadenar recorridos para el mismo diff. Si el recorrido trae órdenes de `.nexakit/fabrica.json` del repo revisado, pide aprobación antes de lanzar. `/fabrica` sigue valiendo.
- El bloque de instrucciones de CLAUDE.md, AGENTS.md y GEMINI.md cambia con ella; las instalaciones con el bloque anterior se actualizan solas al volver a ejecutar `npx nexakit`.
- La skill `fabrica`, el README, la guía de comandos y la documentación de la fábrica ya no dicen que sea opcional ni que solo corra a petición.

## 0.12.2

### Subagentes con una orden por llamada

- Los subagentes de nexakit encadenaban varias órdenes en una sola llamada a Bash (`cd`, `;`, paréntesis, subshells). Claude Code no puede analizarlas y pedía permiso cada vez. Ahora todos los agentes con shell llevan la regla: una orden por llamada, rutas absolutas en lugar de `cd`, sin `;`, `&&`, `||` ni subshells, un `|` solo hacia `head`, `tail` o `grep`, herramientas de lectura y búsqueda en lugar de `cat`, `grep` o `ls`, y llamadas independientes en paralelo.
- La regla está en los diez agentes del plugin `niveles` (0.3.1, que también usa Antigravity) y en los cuatro niveles y los seis especialistas de Codex, desde un texto común en `src/regla-ordenes-simples.js`. Para actualizar los de Codex: `nexakit codex agentes --apply --actualizar`.

## 0.12.1

### Arreglos de seguimiento del enrutador

- El aviso de evidencia caducada ya no da por sin medir los modelos de Antigravity que el banco mide a propósito con otro esfuerzo: un modelo cuenta como medido si su base tiene alguna fila.
- Los finalistas de la fase 2 de cada estación son el mejor par de cada IA medida, más los mejores restantes hasta llegar a 3 (o a tantas IA como haya, si son más de 3); un empate ya no deja a Codex sin finalistas.
- La nota de error repetido, en Claude y en Antigravity, remite a `~/.nexakit/nexakit lecciones registrar --regla … --porque …` en vez de a la memoria persistente (plugin `nexakit-lecciones` 0.3.6).
- `lecciones registrar --help` o `-h` ya no marca como guardadas las correcciones pendientes.
- `nexakit fabrica banco` sin subcomando o con `--help` muestra la ayuda en vez de «Orden desconocida».
- `nexakit fabrica banco ejecutar` atiende Ctrl+C: aborta la ejecución en curso, borra su repo temporal y no lanza las siguientes; un segundo Ctrl+C sale con 130.

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

- Casos con fallos sembrados en `bench/casos/<estacion>/<caso>/` para seguridad, arquitectura, pruebas, rendimiento y documentación, con casos limpios para medir los falsos positivos. Cada caso con fallo siembra al menos 5 fallos de su estación, así una medición perfecta de la fase 2 (2 casos con fallo y 1 limpio) supera el umbral del riesgo medio. El validador rechaza los fallos repetidos, los del mismo archivo a menos de 7 líneas (para que un hallazgo no case con dos) y las claves que faltan, se repiten, no están normalizadas, son cortas o son genéricas o raíz de una genérica («error», «seguridad», «prueb», «readme», «cobertura»...), y exige a cada fallo de documentación una clave propia.
- La medición cuenta por fallo sembrado, no por caso: cada fallo encontrado es un acierto y cada fallo no encontrado o falso positivo es un fallo, con un tope de 3 falsos positivos por ejecución. Un hallazgo acierta si señala el archivo del fallo, una línea de su rango con 3 líneas de margen y nombra alguna de sus claves en su categoría, en su descripción o en su evidencia. Las claves están en `esperado.json` (`claves`: de 2 a 8 raíces por fallo, de 4 caracteres o más salvo siglas como `tls` o `xss`, que casan como palabra completa); se comparan sin tildes ni mayúsculas, separando camelCase y saltando palabras vacías («acceso a los datos» casa con `acceso-datos`). La categoría no tiene que coincidir, porque el revisor la escribe con sus palabras; las claves evitan que otro defecto a pocas líneas cuente como el fallo sembrado. En los casos de documentación, un hallazgo sobre un documento del caso (donde no se mira la línea) encuentra un fallo solo si nombra una clave propia de ese fallo, que no compartan los demás.
- Lo medido se suma a `~/.nexakit/fabrica/evidencia.json` por IA, modelo, esfuerzo y estación, como observaciones de fuente `banco` (los veredictos reales pesan más). El enrutador elige con esa evidencia el modelo más barato cuyo cuantil del 5 % alcanza el umbral del riesgo, y la fase 2 toma de ella los tres finalistas de cada estación.
- `nexakit fabrica banco planificar [--fase 1|2] [--estacion e]` calcula las llamadas, los tokens estimados y la huella, y guarda el plan; no ejecuta nada. La fase 1 mide cada modelo con su esfuerzo más bajo (en Antigravity, donde el esfuerzo va dentro del id, la variante más baja de cada modelo base); la fase 2 mide los tres finalistas por estación (en Antigravity, las variantes `-medium` y `-high` de su base) y necesita antes la fase 1.
- `nexakit fabrica banco ejecutar --huella <huella>` solo corre el plan guardado si la huella coincide, en primer plano y con progreso, con la propia fábrica y en un repo temporal sin lecciones, con un nombre de proyecto neutro y aleatorio que no delata la medición. Consume el plan antes de empezar (una aprobación vale para una sola ejecución, aunque se corte) y muestra un resumen por estación (aciertos, fallos, inválidas y tokens). Gasta tokens: la skill `fabrica` lo propone solo si la persona lo pide y espera su sí explícito, también para la fase 2.

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
