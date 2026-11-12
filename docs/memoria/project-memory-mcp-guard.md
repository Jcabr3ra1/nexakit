# RG — MCP de memoria con raíz fija y lectura limitada

## Estado

RG-1 aprobado y su implementación/pruebas autorizadas el 2026-10-12
(America/Bogota). Profundidad SDD rigurosa por afectar
la separación entre proyectos y el acceso a archivos privados.

Este documento no concede permisos por sí mismo. La aprobación humana posterior
autorizó código, dependencias fijadas sin scripts de instalación y pruebas aisladas
de RG-1. La base está implementada; su cierre de evidencia se registra abajo.
RG-2/RG-3 y la activación compartida siguen pendientes y no están autorizados.

## Problema y evidencia

El piloto encontró que el servidor filesystem puede sustituir su carpeta
configurada por las raíces que comunica el cliente. Una lista de herramientas
de lectura no corrige ese cambio de alcance.

Prueba del 2026-10-12, con el paquete filesystem `2026.8.31` y SDK `1.30.0`
ya presentes en caché, desde la carpeta fuente de Agent Toolkit:

- Con raíz de cliente igual a la bóveda: listado correcto y lectura real de
  `00-INICIO/Estado actual.md`, con huella idéntica a la nota local.
- Con raíz de cliente igual al repositorio fuente: el directorio permitido se
  sustituyó por el repositorio. No se leyó un archivo fuera de la bóveda.
- El servidor publicó 14 herramientas; las nueve de lectura estaban presentes.
  El filtro del cliente de prueba no convirtió al servidor en uno sin escritores.
- Fue una prueba MCP independiente, no una sesión nativa de Codex. No hubo
  inferencias, descargas, escrituras de herramientas o cambios de configuración.

La biblioteca revisada tiene base `e659337`. `src/connect.js` configura el
servidor filesystem directo y una política por cliente; no tiene el intermediario
propuesto aquí. Los borradores de R3 están locales y sin versionar.

La documentación oficial distingue roots de un control de acceso y recomienda
configuración explícita para nuevos diseños. Roots está deprecado en la revisión
2026-07-28, pero sigue operativo: su deprecación no corrige esta instalación.
[Fuente: roots en el SDK oficial](https://py.sdk.modelcontextprotocol.io/handlers/sampling-and-roots/).

## Objetivo

Crear un intermediario STDIO reutilizable que conserve una única bóveda durante
toda su sesión y exponga exclusivamente nueve herramientas de lectura.
La carpeta de trabajo del host, sus capacidades o una notificación roots no
otorgan permisos ni cambian la raíz del intermediario o de su proceso interno.

No pretende implementar un sistema de archivos nuevo ni certificar aislamiento
del sistema operativo. Protege el límite del protocolo entre el host y el backend
local de confianza, con límites de recursos y comprobaciones de rutas.

## Fuera de alcance

- Ejecutar modelos, consultar cuentas, leer credenciales o habilitar gasto/API.
- HTTP, OAuth, sampling, elicitation, prompts, recursos o clientes de IA nuevos.
- Escribir notas, activar sincronización, modificar Obsidian o otras memorias.
- Cambiar AVISENS, las Skills instaladas o sus conexiones.
- Sustituir automáticamente todos los servidores existentes.
- Modificar connect/status o el esquema del manifiesto en RG-1.
- Garantizar contención de un proceso comprometido, cifrado, o protección frente
  a un adversario local que pueda sustituir archivos durante las operaciones.
- Commit, push, release o publicación.

## Modelo de confianza

Se confía en el Node seleccionado, las dependencias fijadas y el manifiesto local
aprobado. La raíz sale del manifiesto en el arranque, no de un argumento de una
herramienta, del entorno, del cwd o de un pedido del modelo.

El host puede enviar mensajes inválidos, nombres de herramientas arbitrarios,
rutas externas, raíces vacías o distintas y notificaciones tardías. Ninguno puede
ampliar permisos. El backend no recibe capacidades, solicitudes o notificaciones
del host por un canal transparente.

La separación es de aplicación/protocolo, no una sandbox del kernel. Las
comprobaciones de rutas y metadatos no eliminan todas las carreras locales de
sustitución de directorios; no presentar una revisión posterior como garantía
de que nunca se produjo una lectura bajo un ataque local concurrente.

## Diseño propuesto

### Entrada y raíz

Nueva entrada dedicada, sin activar conexiones:

```text
node <toolkit>/bin/project-memory-mcp.js --manifest <manifiesto-absoluto>
```

- Exigir exactamente el manifiesto explícito; rechazar argumentos desconocidos,
  múltiples raíces y un comando/backend indicado por el llamante.
- Validar el manifiesto v1 con el esquema existente y `security.mcpAccess`
  igual a `read-only`. No modificar el manifiesto ni relajar el esquema.
- Resolver vaultPath respecto al manifiesto, nunca al cwd. Rechazar `/`, el
  directorio personal, raíces solapadas con el repositorio fuente, enlaces
  simbólicos, recursos especiales y permisos/propiedad inseguros.
- Comprobar los componentes físicos del manifiesto y la bóveda en plataformas
  admitidas; fijar la identidad de la raíz (dispositivo, inode, dueño y modo).
- La raíz se conserva en memoria y se revalida antes y después de cada operación.
  No releer el manifiesto para aceptar una raíz nueva durante una sesión.

### Separación del host y el backend

El intermediario usa el SDK oficial como servidor frente al host y como cliente
STDIO frente al filesystem instalado como dependencia propia del Toolkit.

- El cliente interno declara capacidades vacías, sin roots, sampling o elicitation.
- Se inicia exclusivamente el ejecutable del paquete filesystem fijado, mediante
  el Node previsto y una lista de argumentos; sin shell, npx o comandos del host.
- No reenviar initialize, roots/list_changed, callbacks, métodos desconocidos,
  variables arbitrarias o metadatos del host al backend.
- Verificar al arrancar y antes de una operación que los directorios efectivos
  del backend corresponden exactamente a la raíz fijada. Ante discrepancia,
  cerrar el backend y rechazar nuevas operaciones; no unir directorios.
- Una notificación roots del host se ignora como señal informativa; no se pide
  roots al host y nunca se usa su respuesta para decidir acceso.
- No anunciar readiness ni un catálogo utilizable hasta comprobar el backend.

Las versiones candidatas son SDK `1.30.0` y filesystem `2026.8.31`, fijadas
exactamente en package.json y package-lock. Son las versiones observadas en la
prueba, no una afirmación de ser las últimas ni una evaluación de vulnerabilidades.

El 2026-11-11 el SDK se subió a `1.32.2`, también fijado exactamente, para cerrar
el aviso de severidad alta que `npm audit` atribuía a la `1.30.0`; la suite
completa pasó con esa versión. Quedan tres avisos moderados (`glob` y
`minimatch`) que dependen de filesystem `2026.8.31` y solo se cierran con su
línea 2.x. Ese salto se aplazó: la 2.x usa el SDK nuevo, añade las herramientas
de escritura `append_file` y `copy_file` y ofrece `--read-only`, así que exige
migrar este guardián y revisar los permisos de Claude Code.
RG-1 añade dos dependencias directas y su árbol transitivo, actualmente ausentes
de la biblioteca; deben revisarse antes de instalarlas. No usar rutas de caché
personales en el código, en la configuración portable o en las pruebas.

La base del SDK inspeccionado negocia protocolos hasta 2025-11-25. Probar
negociación admitida y rechazo incompatible; no prometer soporte de 2026-07-28
o de todos los hosts. Un rechazo no habilita el filesystem directo como fallback.

### Catálogo y llamadas

La lista fija coincide con READ_TOOLS de connect, pero no se importa connect
para arrancar un servidor ni se refactoriza su comportamiento en RG-1:

| Grupo | Herramientas públicas |
| --- | --- |
| Texto y medios | read_text_file, read_media_file, read_multiple_files |
| Directorios | list_directory, list_directory_with_sizes, directory_tree |
| Búsqueda y metadatos | search_files, get_file_info |
| Alcance | list_allowed_directories |

- Publicar solo esos nombres; filtrar el catálogo del backend antes de devolverlo.
  Si falta una herramienta esperada, su contrato es incompatible o una herramienta
  permitida no se anuncia de solo lectura, bloquear el arranque. Esto no autentica
  la semántica de un backend comprometido: la versión de confianza se revisa aparte.
- Bloquear un tools/call no listado antes de contactar al backend, aunque el host
  lo invoque sin haber solicitado catálogo. No depender solo de readOnlyHint.
- Mantener esquemas de entrada cerrados revisados, validar tipos y rechazar
  propiedades extra; no reenviar objetos arbitrarios recibidos del host.
- Todas las rutas deben ser absolutas y pertenecer a la bóveda por componentes
  físicos, no por un prefijo textual. Rechazar traversal, controles, symlinks,
  archivos especiales, hardlinks de archivos y rutas de credenciales.
- Árboles y búsquedas añaden exclusiones obligatorias de credenciales y
  directorios internos; el host no puede quitarlas mediante sus argumentos.
- En read_multiple_files comprobar toda la lista antes de delegar cualquiera.
  La identidad de raíz no cambia por un archivo ausente, inválido o denegado.
- list_allowed_directories informa la raíz fijada después de comprobar el
  backend; no devuelve raíces del host ni una lista cacheada si falló el control.

### Recursos, errores y operación

Límites propuestos para la primera base, medidos en bytes:

- Entrada JSON-RPC: 1 MiB por mensaje; ruta: 4.096 caracteres.
- Lectura explícita: hasta 8 MiB por archivo y 12 MiB acumulados por llamada;
  read_multiple_files admite hasta 100 archivos, con tamaño revisado antes de leer.
- Respuesta STDIO: hasta 16 MiB, contando serialización y base64. Una respuesta
  que no cabe se rechaza; no truncar silenciosamente para aparentar éxito.
- Una operación delegada activa; otra recibe un error ocupado, sin cola ilimitada.
- Arranque y llamada: 10 s cada uno. Timeout o cancelación de operación activa
  cierra el backend y deja la sesión no utilizable, sin reinicio/retry automático.
- Recorridos de directorios están sujetos al timeout y al tamaño de respuesta;
  esto no acredita una cota previa de CPU o número de entradas del proceso hijo.

STDOUT contiene únicamente MCP. STDERR y errores públicos contienen códigos y
mensajes acotados, no notas, argumentos completos, paths ajenos o trazas crudas.
No heredar API keys, tokens o variables del host al backend; conservar solo el
entorno operativo mínimo, sin sustituir HOME o CODEX_HOME.

Usar isCredentialPath y las comprobaciones existentes de sensitive-data cuando
correspondan. Bloquear rutas como .env, claves y directorios internos de Git,
Obsidian o clientes. Revisar texto devuelto con los detectores existentes antes
de emitirlo; son heurísticas, no un certificado de ausencia de todo secreto.

Ante un fallo de raíz, backend, protocolo o límite: descartar la respuesta y
cerrar el backend cuando el fallo comprometa la sesión. No probar escritores
sobre una bóveda real. EOF/cierre normal debe terminar el hijo sin procesos huérfanos.

## Alternativas

| Opción | Evaluación |
| --- | --- |
| Pedir al usuario abrir siempre la bóveda como workspace | No impide un cambio posterior de roots ni constituye control de acceso |
| Solo enabled_tools en el cliente | Limita herramientas, no fija la raíz; el riesgo ya fue reproducido |
| Parchear la copia de npx | Se pierde al actualizar y altera una instalación ajena al Toolkit |
| Implementar nueve operaciones de filesystem desde cero | Evita el backend, pero amplía sustancialmente mantenimiento y pruebas de archivos/medios/recorridos |
| Intermediario fijo con backend versionado | Propuesta: frontera explícita y reutilizable; añade dependencias y un proceso local |

## Criterios de aceptación

Resultados de RG-1 al final del documento. CA-RG12 pertenece a RG-2 y permanece
pendiente; los criterios locales no lo sustituyen.

| ID | Escenario y resultado requerido |
| --- | --- |
| CA-RG01 | Manifiesto válido inicia con una raíz física; inválido, raíz amplia o insegura bloquea antes de spawn |
| CA-RG02 | Cwd distinto y host sin roots, con roots de otro proyecto, vacías o tardías mantienen la misma bóveda |
| CA-RG03 | tools/list publica exactamente nueve herramientas; llamada de escritura/arbitraria produce cero delegaciones |
| CA-RG04 | Las nueve lecturas funcionan sobre fixtures permitidos, incluidas imágenes pequeñas y listado/búsqueda |
| CA-RG05 | Traversal, prefijo hermano, symlink, hardlink, especial y credenciales se rechazan sin leer el recurso rechazado |
| CA-RG06 | Una lista que incluye una ruta inválida no inicia ninguna lectura delegada de esa lista |
| CA-RG07 | Backend con raíz distinta, catálogo incompatible o fallo no produce readiness/fallback; se cierra |
| CA-RG08 | Límites exactos, exceso, respuesta grande, segunda llamada, timeout y cancelación tienen resultado explícito y acotado |
| CA-RG09 | EOF/cierre/error no deja hijos; no hay reinicio automático ni respuesta tardía del hijo cerrado |
| CA-RG09b | Initialize repetido, callbacks del backend y métodos del host no previstos no arrancan otro hijo ni se reenvían |
| CA-RG10 | Bytes/modes de fixtures intactos; stdout válido; logs y errores sin tokens ficticios ni contenido privado |
| CA-RG11 | Lock reproducible, carga sin descargas en runtime y regresión existente sin fallos no resueltos |
| CA-RG12 | RG-2 demuestra lectura por el host real y root fija; el smoke standalone no se presenta como esa evidencia |

Los negativos usarán archivos ficticios y spies/barreras de IO y subprocess para
demostrar ausencia de lectura/spawn/delegación, no solo comparar un mensaje.
La invariancia de roots se prueba en el mismo proceso después de la inicialización.

## Plan y puertas de aprobación

### RG-1 — Base aislada

Archivos de la base autorizada:

- bin/project-memory-mcp.js: entrada dedicada y ciclo de vida STDIO.
- src/memory-mcp-policy.js: raíz, entradas, lista fija y límites.
- src/memory-mcp-server.js: intermediario y backend local de confianza.
- src/memory-mcp-transport.js: framing STDIO acotado y errores sin datos crudos.
- test/memory-mcp-policy.test.js y test/memory-mcp-server.test.js; fixtures
  auxiliares de proceso si las pruebas necesitan un backend reproducible.
- test-support/memory-mcp-fixture.js: fixtures privadas con limpieza por identidad.
- package.json y package-lock.json: dos dependencias fijadas y entrada bin.
- Este documento y docs/guias/uso.md: evidencia y uso, sin datos operativos privados.

Orden: validar contratos y dependencias → controles de raíz/entrada → ciclo de
vida/backend → catálogo/delegación → pruebas adversas → regresión y cierre.
Revisar también compatibilidad de Node; el smoke anterior solo acreditó
macOS/arm64 con Node v24.14.1, no todas las versiones admitidas por package.json.

Aprobación RG-1 debe autorizar expresamente implementación por el agente y pruebas
aisladas, además de instalación local de dependencias desde npm con lock, sin
scripts de instalación. No consultar cuentas, ejecutar IA o escribir configuraciones
globales. Un resultado parcial no habilita RG-2.

### RG-2 — Conectar y probar el piloto

Requiere RG-1 revisado y autorización separada. Preparar el diff de la única
entrada agent-toolkit-memory, usando Node y el bin local con manifiesto explícito;
conservar todos los bloques ajenos y dejar deshabilitada hasta validar el plan.
Migrar la entrada legacy solo si corresponde exactamente al piloto autorizado.
No ejecutar connect/status como reparación implícita ni extenderlo a otros agentes.

Después de la activación autorizada: probar catálogo efectivo, directorios y nota
conocida por el host correcto, incluyendo un cambio de workspace/roots que no
altere el alcance. No iniciar otra IA para simular esa validación ni actualizar
las notas técnicas basándose solo en una configuración guardada.

### RG-3 — Integración portable posterior

Solo después del piloto: especificar por separado adopción del transporte en
connect/status, migración de otros clientes y actualización de guías. No convertir
el backend directo actual en evidencia de raíz protegida ni cambiar defaults
sin una migración revisada. No está autorizado por aprobar RG-1.

## Riesgos, recuperación y evidencia de cierre

- Dependencias nuevas: revisión de origen, licencias, lock e impacto transitivo.
  No incorporar paquetes de la caché personal como dependencias de publicación.
- Backend o sesión fallida: cerrar y conservar datos; no rollback ciego de archivos.
- Instalación parcial: informar lo realmente cambiado y mantener el MCP apagado.
- Reversión del piloto: deshabilitar la entrada propia mediante diff revisado;
  no borrar la bóveda o restaurar la configuración compartida completa.
- Una configuración legada o una suite verde no certifican aislamiento del host.

La implementación RG-1 no modifica connect/status, configuraciones compartidas,
Skills o memorias. No se inició IA ni se consultaron cuentas. El porcentaje global
previo no sustituye estos criterios ni una revisión de esfuerzo de la corrección.

## Evidencia RG-1 — 2026-10-12

Resultado: **Aprobado con observaciones como base aislada RG-1**.
No autoriza RG-2/RG-3, instalación global, commit o push.

- npm confirmó las dos versiones fijadas, requisitos declarados de Node e
  integridad de distribución. Se generó el lock y se ejecutó npm ci con scripts,
  audit, fund y update-notifier deshabilitados, usando configuración/cache propias.
- SDK declara MIT; filesystem declara SEE LICENSE IN LICENSE, pero el tarball
  no adjunta ese archivo. La [licencia actual del repositorio oficial](https://raw.githubusercontent.com/modelcontextprotocol/servers/main/LICENSE)
  describe una transición de MIT a Apache-2.0; no se atribuye automáticamente
  ese texto de main al artefacto fijado. Revisión de atribuciones/distribución
  y auditoría de vulnerabilidades no están acreditadas por esta base privada.
- npm marca el versionado fechado de filesystem como deprecado. Se conserva el
  pin aprobado y probado; no hubo sustitución silenciosa por latest o por 1.0.0.
- Los primeros intentos focalizados detectaron formato multimedia y saneamiento
  de errores incompatibles, después un parser con límite menor al aprobado.
  Se corrigieron en RG-1, conservando el historial de resultados fallidos.
- Dos primeras regresiones completas: 3.360/3.361, con una falla en la expectativa
  antigua de dependencias de task-cli.test.js. Esa expectativa exigía solamente
  Ajv y no admitía los dos paquetes aprobados. Se actualizó a los tres valores
  exactos y se conservaron las comprobaciones de los bins existentes; también se
  comprobó el bin nuevo y su entrada en el lock. No se eliminaron casos.
- Selección final de policy/server/task-cli: 138/138, exit 0, sin omisiones.
  Los dos archivos nuevos de RG contienen 82 casos; los otros 56 son regresión TP.
- Regresión final: `node --test --test-reporter=tap --test-concurrency=2`,
  3.364/3.364, exit 0, sin fallos, cancelaciones, omisiones ni todo;
  102.484,19 ms. La salida fue resumida por un recolector, sin guardar contenidos
  de notas o salidas extensas en esta biblioteca.
- `node --check` individual: bin, tres módulos, dos suites, helper de fixtures
  y task-cli.test.js, todos exit 0. Ayuda local comprobada sin abrir servidor.
- Lock con 104 paquetes resueltos, frente a los cinco anteriores; Ajv instalado
  conserva 8.20.0. Algunas dependencias transitivas expresan Node 20 o >=22;
  engines >=20 del Toolkit no se presenta como evidencia para Node 21 o todas
  las versiones. Solo se ejecutó en macOS/arm64 y Node v24.14.1.
- Las pruebas usan manifest/bóvedas ficticias, backend empaquetado local y
  hosts MCP sintéticos. No acreditan conexión nativa de Codex o RG-2.

### Trazabilidad de aceptación

| Criterio | Evidencia RG-1 | Alcance |
| --- | --- | --- |
| CA-RG01 | Manifiestos, permisos, alias físicos, overlap y spy de factory sin arranque | Fixtures, macOS |
| CA-RG02 | CLI real desde cwd fuente; hosts sin roots, vacías o ajenas, aviso tardío y contador de requests igual a cero | Host sintético, no Codex |
| CA-RG03 | Catálogo con escritores filtrado; llamadas writer/desconocida con contador de delegaciones intacto | Intermediario y fake backend |
| CA-RG04 | Nueve llamadas al filesystem empaquetado, PNG y recurso binario con URI exacta | Fixture local y paquete fijado |
| CA-RG05 | Traversal, prefijo hermano, symlinks, hardlinks, FIFO, permisos y credenciales; sin content IO del recurso rechazado | Tests de policy y gateway |
| CA-RG06 | Lista con ruta ajena después de archivo válido conserva cero delegaciones nuevas | Backend spy |
| CA-RG07 | Scope diferente o cambiante, catálogo incompleto/tipo distinto; sin readiness y un cierre | Backend controlado |
| CA-RG08 | Bytes exactos y exceso, fragmentos y batches, respuesta exacta/excesiva, ocupado, timeout y cancelación | Transport/core aislados |
| CA-RG09 | PID de backend/CLI terminado; EOF, cancelación, resultado tardío y fallo de cleanup explícito | Procesos propios y simulación de error |
| CA-RG09b | Initialize repetido no reinicia; callback inesperado inyectado cierra, sin delegación ni retry | CLI sintética y señal de backend |
| CA-RG10 | Notas/medios de fixture intactos, errores sin datos, secreto ficticio también en base64, exclusiones de árbol/búsqueda | Heurísticas, no auditoría universal |
| CA-RG11 | npm ci con lock, bin empaquetado sin npx en runtime y regresión completa verde | Sin evaluación de todas las plataformas o vulnerabilidades |
| CA-RG12 | Pendiente | Requiere RG-2 autorizado y host real |

La frontera queda comprobada en estos escenarios, no certificada frente a un
backend comprometido o un atacante local concurrente. La licencia del artefacto
filesystem y su deprecación siguen como observaciones para adopción/distribución.

## Preguntas y decisiones pendientes

- RG-1 fue aprobado e implementado con las versiones y límites anteriores.
  No se amplió a otros subsistemas; el ajuste de la expectativa de dependencias
  en task-cli.test.js fue necesario para conservar la regresión del contrato nuevo.
- Revisar las observaciones de licencia, deprecación y compatibilidad antes de
  una adopción o distribución nueva; no reinterpretarlas como evaluaciones resueltas.
- Elegir cuándo autorizar RG-2 y RG-3 después de revisar evidencia, no ahora.

## Referencias locales

- [Propuesta del piloto y conexión](../operacion/agent-toolkit-codex-memory.md)
- [Adopción de memoria R3](../operacion/agent-toolkit-self-memory.md)
- [Conexión actual](project-memory-connect.md)
- [Esquema de manifiesto](../../schemas/project-memory.schema.json)
- [Controles de lectura existentes](../../src/task-verify-files.js)
- [Detectores existentes](../../src/sensitive-data.js)
