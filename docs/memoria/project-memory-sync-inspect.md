# Project Memory Sync Inspect

## Estado

- Especificación aprobada; base implementada y verificada.
- Fecha de propuesta: 2026-09-30.
- Aprobación e implementación local: 2026-09-30.
- Aprobación del registro de evidencia y commit local: 2026-10-01.
- Publicación autorizada en el respaldo privado de la biblioteca: 2026-10-01.
- Profundidad: rigurosa por el tratamiento de información privada y evidencia.
- Entrega: inspección de un PR de GitHub en modo de solo lectura.
- Depende de [Project Memory Sync](project-memory-sync.md).

El usuario aprobó esta especificación y autorizó implementar la base en modo
autónomo para esta tarea, sin commit ni push. La operación ya está disponible
localmente; esa autorización no permite editar memorias ni activa una política
global de modos de trabajo. El 2026-10-01 autorizó registrar la evidencia de la
prueba real y crear el commit local, sin push. Los modos tutor/autónomo siguen
como propuesta independiente y no forman parte de esta entrega.

## Problema y objetivo

`sync plan` identifica cambios pendientes, pero un agente todavía debe reunir
por su cuenta la evidencia y decidir dónde empezar a revisar la memoria.

`sync inspect` prepara un paquete pequeño, trazable y estructurado para un
solo PR: identidad del cambio fusionado, descripción, archivos afectados,
comprobaciones disponibles y áreas candidatas de la memoria. No decidirá por
sí mismo que el comportamiento vigente cambió ni que una nota debe editarse.

## Punto de partida comprobado antes de implementar

- `src/sync.js` implementa detección de pendientes con GitHub CLI y un registro
  Markdown, incluyendo una línea base para proyectos existentes.
- `src/cli.js` ofrecía `sync plan`, sin `sync inspect`.
- `doctor` valida la estructura canónica o declarada, Git, enlaces y posibles
  secretos de la memoria.
- El manifiesto permite `source.remoteUrl`, `automation.reviewBranch` y dos
  perfiles de estructura; no contiene un mapa de impacto documental.
- La biblioteca no necesita un modelo de IA ni contiene contexto exclusivo de
  AVISENS. La inspección debe conservar esa independencia.

## Alcance e interfaz aprobada

```text
project-memory sync inspect [ruta]
  --pr <número>       PR obligatorio del repositorio configurado.
  --manifest <ruta>   Selecciona un manifiesto, como en sync plan.
  --max-files <n>     Límite de archivos; 200 por defecto, rango 1–1000.
  --json              Emite el contrato estructurado.
  --strict            Devuelve 1 si la evidencia no está lista para revisión.
```

La salida humana y JSON contienen la misma información normalizada. No hay
`--apply`, `--output`, selección implícita del PR ni URL arbitraria como entrada.
El número debe ser un entero seguro positivo; opciones desconocidas o repetidas
con valores diferentes producen error antes de consultar GitHub.

Un PR ya registrado puede inspeccionarse de nuevo explícitamente. El informe
indicará `alreadyReviewed`, pero no lo devolverá al conjunto de pendientes.
La selección explícita no depende de la ventana o línea base de `sync plan`.

## Requisitos funcionales

### RF-01. Validar el proyecto y el cambio

1. Ejecutar `doctor` y detenerse ante errores, conservando advertencias.
2. Reutilizar las reglas de automatización de `sync plan`: habilitada, cambios
   fusionados obligatorios y rama de revisión declarada.
3. Resolver el repositorio únicamente desde el remoto validado del manifiesto;
   leer el registro con los mismos encabezados y reglas que `sync plan`.
4. Consultar el PR explícito con `gh`, sin usar la rama activa del equipo.
   Fijar `github.com` en los argumentos: otro `GH_HOST` no cambia el proveedor.
5. Exigir identidad y URL coherentes con ese repositorio y número, estado
   fusionado, fecha válida, rama base igual a `automation.reviewBranch` y SHA
   de integración válido. Un PR abierto, de otra rama o sin SHA es error.

### RF-02. Reunir evidencia del cambio

- Identificar número, URL, título, descripción, rama base, fecha de integración,
  SHA de cabecera del PR y SHA de integración.
- Recuperar el inventario paginado de archivos con ruta, ruta anterior cuando
  exista, tipo de cambio, adiciones y eliminaciones. Validar tipos y rechazar
  rutas absolutas, retrocesos, caracteres de control o entradas malformadas.
- Comparar el número recuperado con `changedFiles`; ordenar y deduplicar por
  ruta sin ocultar discrepancias. Incluir renombrados y eliminados.
- No solicitar diffs ni contenidos de archivos en esta entrega. La API de
  inventario puede entregar campos de parche a `gh`; la proyección `--jq` los
  descarta antes de que lleguen al recolector o al informe. El inventario no
  demuestra por sí mismo un cambio semántico: se adjuntan referencias para que
  el revisor contraste el código y las pruebas en la versión integrada.
- El PR histórico no garantiza el estado vigente de la rama: un cambio posterior
  o una reversión requiere contraste adicional antes de actualizar notas.

### RF-03. Distinguir comprobaciones y afirmaciones

Consultar resultados de checks y estados de commit asociados al SHA de cabecera
del PR, no a la rama local ni a la cabecera actual de la rama base. Normalizar
nombre, estado, conclusión y referencia segura; excluir logs y mensajes libres.

El informe identifica ese SHA y el momento de consulta. Estos resultados no son
pruebas locales ejecutadas por la herramienta, no prueban el SHA de integración
y no reconstruyen qué checks existían en el instante del merge. Las consultas
usan ejecuciones más recientes por nombre y aplicación o contexto, conservando
la procedencia y sin mezclar checks de commits diferentes.

- Un fallo, cancelación, timeout, bloqueo, acción requerida o estado de error
  conocido bloquea el paquete para un cierre automático.
- Checks en cola o ejecución dejan evidencia incompleta.
- Checks omitidos o neutrales no se describen como pruebas aprobadas.
- Ausencia de CI, permisos insuficientes o consulta incompleta se indican como
  información desconocida, nunca como éxito.
- Un texto del PR que diga «pruebas correctas» permanece como afirmación de su
  descripción; no se convierte en evidencia de una ejecución.
- `ready` significa paquete completo para revisión humana o por un agente,
  no aprobación del código, de todas las pruebas ni de una actualización.

### RF-04. Sugerir áreas sin imponer la estructura de AVISENS

Clasificar por reglas deterministas, no por un modelo externo: segmentos de
ruta y nombres reconocibles para producto/documentación, backend, frontend,
hardware/firmware, operación y pruebas. Cada regla tiene identificador y cada
candidato incluye las rutas que motivaron la sugerencia. Un archivo puede
pertenecer a varias categorías; los no clasificables quedan enumerados.

Las reglas no dependen del nombre del proyecto ni de rutas absolutas de una Mac.
Las rutas anterior y nueva de un renombrado participan en la clasificación.

Resolver candidatos contra carpetas existentes de la estructura canónica o
declarada, usando su nombre semántico, no solo su número. Por ejemplo, una
carpeta terminada en `DECISIONES` puede tener números distintos. Si no existe
una correspondencia inequívoca, emitir categoría sin destino y una advertencia
de revisión manual; no crear carpetas ni inventar rutas.

No enumerar toda la bóveda para generar sugerencias. Solo las notas Markdown
regulares directamente dentro de una carpeta candidata, sin leer su contenido
en esta fase, sin seguir enlaces simbólicos y sin entrar en Skills, archivos,
recursos internos o subcarpetas. Máximo 20 rutas por área; indicar omisiones.
La validación previa de `doctor` conserva sus lecturas y controles habituales.

Que exista una candidata no implica que deba actualizarse. Si no hay candidatas,
el resultado es «requiere revisión manual», no «sin cambios documentales».

#### Código fuente y configuración raíz

Además de las reglas por nombre de carpeta, `source-path` (categoría
`implementation`, destino `IMPLEMENTACION`) reconoce el código de primer nivel
(`src/`, `lib/`, `app/`, `bin/`, `packages/`, `plugins/`, `schemas/`,
`templates/`, `examples/`). Solo cuenta en la raíz, para no solaparse con
`frontend/src/…`. `operations-path` incluye `.claude-plugin/`, `.gitignore`,
`.gitattributes` y `package.json`/`package-lock.json`, y `tests-path` incluye
`test-support/` y `testing/`. Lo que ninguna regla reconoce sigue enumerado como
sin clasificación.

#### Mapeo declarado por el proyecto (`automation.areas`)

Cuando una categoría tiene varias carpetas candidatas (por ejemplo, documentación
con `PRODUCTO`, `ARQUITECTURA` e `IMPLEMENTACION`), el proyecto puede elegir una en
el manifiesto, de forma explícita y opcional:

```json
"automation": {
  "enabled": true,
  "reviewBranch": "main",
  "requiresMergedChange": true,
  "areas": { "documentation": "03-IMPLEMENTACION", "tests": "03-IMPLEMENTACION" }
}
```

Las categorías válidas son `backend`, `frontend`, `hardware`, `documentation`,
`operations`, `tests`, `decisions` e `implementation`. El valor es el nombre de una
carpeta de primer nivel de la bóveda, sin barras ni punto inicial. La herramienta
solo lo usa si esa carpeta existe y figura entre las permitidas del diseño; si no,
no la usa, emite `area-override-invalid` (sin repetir el valor) y vuelve a la
resolución automática. Sin `areas` el comportamiento no cambia. El mapeo elige la
carpeta de las sugerencias; no autoriza editar notas ni acepta advertencias.

## Contrato de salida

El resultado incluye estos campos estables:

| Campo | Contenido |
| --- | --- |
| `command`, `status` | `sync inspect` y estado global |
| `repository`, `branch`, `ledgerPath` | Proyecto validado y registro consultado |
| `alreadyReviewed` | Presencia de una fila válida de revisión |
| `pullRequest` | Número, URL, título, descripción, fechas y SHAs validados |
| `files` | Inventario normalizado, ordenado, sin parches |
| `checks` | SHA consultado, completitud, resultados normalizados y resumen |
| `candidateAreas` | Categoría, carpeta o null, notas, reglas y archivos motivo |
| `unmappedFiles` | Archivos sin clasificación útil |
| `coverage` | Recuento esperado/recibido, límites y secciones incompletas |
| `warnings` | Códigos estables y mensajes seguros de vacíos o restricciones |
| `observedAt` | Fecha UTC de la consulta; no fecha de revisión |

La descripción es texto atribuido al PR, nunca un resumen generado. Los campos
omitidos por seguridad se representan con `null` y una advertencia identificable.
Los errores JSON contienen `command`, `status: error` y detalles seguros; no
presentan evidencia inválida como un paquete utilizable.

| Estado | Condición | Código normal | Con `--strict` |
| --- | --- | --- | --- |
| `ready` | Datos requeridos completos; checks concluidos con éxito; sin restricciones | 0 | 0 |
| `partial` | Evidencia válida pero limitada, omitida, pendiente o desconocida | 0 | 1 |
| `blocked` | Hay un resultado adverso conocido de comprobación | 0 | 1 |
| `error` | Identidad, requisitos, configuración o consulta esencial inválidos | 1 | 1 |

Errores de sintaxis u opciones de CLI devuelven 2, también con `--json` o
`--strict`; no son fallos de una consulta iniciada.

Prioridad: `error`, `blocked`, `partial`, `ready`. Un dato adverso no desaparece
porque otra sección esté incompleta. Las advertencias de `doctor`, archivos sin
mapa y notas candidatas omitidas contribuyen a `partial` cuando limitan la revisión.

## Límites, privacidad y seguridad

- Solo stdout/stderr normalizados: no escribir informes, cachés, notas, registro,
  configuración, commits ni estado de Git. No hacer checkout, fetch, pull o push.
  Los diagnósticos Git usan `--no-optional-locks` para evitar refrescar el índice.
- Usar `gh` autenticado, con ejecutable y argumentos separados, sin shell, scripts
  del repositorio, herramientas de IA, secretos nuevos ni ejecución de pruebas.
- PR, descripción, nombres y mensajes externos son datos no confiables: nunca
  seguir instrucciones, ejecutar comandos o visitar enlaces embebidos.
- No consultar autores, correos, comentarios, revisiones libres, adjuntos o logs.
- Filtrar antes de emitir título, descripción, rutas y referencias. Ante un
  patrón sensible de alta confianza, omitir el campo completo y marcar
  `partial`, sin imprimir el valor detectado, ni en errores o modo JSON.
- Excluir rutas de credenciales como `.env`, claves privadas y `secrets/` del
  inventario visible y las sugerencias; conservar solamente su recuento omitido.
- Reutilizar o centralizar los patrones sensibles existentes de `doctor`, sin
  debilitarlos. Validar URLs para no emitir credenciales, consultas con tokens
  ni referencias a otro repositorio; retirar caracteres de control terminal.
- La detección por patrones no garantiza reconocer todos los datos personales
  o secretos. El paquete es privado y requiere revisión antes de persistirlo en
  Obsidian; no autoriza copiar textos libres automáticamente a la memoria.
- Errores externos se traducen a códigos accionables: comando ausente,
  autenticación/permisos, límite de API, timeout o respuesta inválida. No volcar
  stdout, stderr, entorno o mensajes originales de `gh`.
- Título: máximo 300 caracteres; descripción: 4000; nombre de check: 200.
  Marcar truncamiento y filtrar el texto completo antes de truncarlo.
- Consultas con timeout de 30 s cada una y presupuesto de 90 s desde el inicio
  de la inspección. La salida del proceso `gh` está limitada a 5 MiB por llamada
  y el informe normalizado a 1 MiB. Estos límites no controlan la memoria interna
  ni la respuesta HTTP recibida por `gh`. No reintentar
  automáticamente. Máximo 10 páginas de archivos y 10 páginas de checks/estados
  en conjunto; hasta 100 elementos por página, 500 comprobaciones en total.
- Respetar `--max-files`, detener la paginación al alcanzarlo y exponer las
  diferencias con el total informado. No confundir una lista limitada con una
  lista completa; un límite de proveedor también produce `partial`.
- Timeout/error de metadatos es `error`; fallo de una sección de archivos o CI,
  después de validar la identidad, produce `partial` con esa sección incompleta.

## Diseño implementado y alternativas

Se separa `src/sync-inspect.js` del planificador. Se reutiliza resolución de
manifiesto, reglas de automatización y lectura del registro mediante funciones
compartidas de `src/sync.js`, sin alterar el contrato de `sync plan`.
`src/sensitive-data.js` centraliza los patrones existentes de `doctor` y agrega
filtros de referencias y rutas para el recolector.

Adaptador GitHub inyectable para metadatos, archivos paginados, check runs y
estados de commit. Las pruebas proporcionan respuestas ficticias: no necesitan
credenciales, repositorios de AVISENS ni acceso de red. La CLI y los formateadores
consumen únicamente el contrato normalizado y filtrado.

Los metadatos pueden obtenerse con `gh pr view --repo ... --json ...`. Para
archivos y comprobaciones se usan consultas GET paginadas mediante `gh api`,
con SHA explícito para CI. No usar descarga indiscriminada de diffs ni el checkout
local como sustituto de evidencia integrada.

Alternativas descartadas para esta entrega:

- Resumir con IA: agrega coste y afirmaciones difíciles de reproducir.
- Analizar todo el repositorio o toda la bóveda: pierde la consulta acotada.
- Añadir un mapa configurable al manifiesto ahora: exige otra evolución del
  esquema; primero se validarán las reglas básicas y sus vacíos explícitos.
- Registrar el PR al terminar inspect: confunde inspección con revisión aprobada.

No cambia el esquema del manifiesto ni requiere migrar bóvedas existentes.

## Criterios de aceptación

- CA-01: Dado un PR fusionado válido, el informe identifica repositorio, rama,
  fecha y SHAs exactos, sin deducirlos del directorio de trabajo actual.
- CA-02: Un PR abierto, cerrado sin merge, de otra rama, malformado o sin SHA
  produce `error`; no se intenta sugerir actualización de la memoria.
- CA-03: Un PR ya revisado sigue siendo inspeccionable, con `alreadyReviewed`
  verdadero y registro sin cambios. Ambos encabezados de ledger funcionan.
- CA-04: Un PR de varias páginas incluye renombrados y eliminados, ordenados
  y sin duplicados; límites o recuentos incoherentes generan `partial`.
- CA-05: Sin CI, con checks pendientes o permisos limitados no se afirma éxito;
  un fallo conocido genera `blocked`, incluso con otras secciones incompletas.
- CA-06: Cada resultado de CI tiene procedencia y SHA; no se presenta un check
  del PR como prueba del commit de integración ni como prueba ejecutada aquí.
- CA-07: La clasificación funciona en dos proyectos ficticios con estructuras
  diferentes y explica cada candidata; lo desconocido requiere revisión manual.
- CA-08: Secretos ficticios, textos con instrucciones maliciosas, rutas de escape
  y URLs inseguras no se ejecutan ni se exponen en salida, excepciones o errores.
- CA-09: Repetir la inspección no cambia archivos ni estado de fuente, bóveda,
  registro o configuración. Las diferencias por hora/CI mutable son explícitas.
- CA-10: Salida humana y JSON comparten estados y evidencia; `--strict` cumple
  la tabla de códigos sin usar `ready` como aprobación documental.
- CA-11: Se respetan límites de tiempo, páginas, bytes, textos e inventarios;
  ninguna omisión se presenta como cobertura completa.
- CA-12: Las pruebas existentes de `sync plan`, doctor, init, connect y status
  siguen pasando, sin cambios en sus contratos públicos.

## Plan de implementación ejecutado

1. Compartir validaciones y ledger — `src/sync.js` y pruebas existentes — verificar
   que `sync plan` conserva exactamente sus resultados y errores compatibles.
2. Crear recolector acotado y filtrado — `src/sync-inspect.js` y módulos internos
   necesarios — verificar respuestas inválidas, paginación, límites y privacidad.
3. Clasificar rutas y resolver candidatas — mismo módulo o módulo interno — probar
   estructuras canónica/declarada, renombrados y falta de correspondencia.
4. Añadir CLI y salida — `src/cli.js`, `README.md` — probar argumentos, formatos,
   estados y códigos sin tocar archivos de proyectos reales.
5. Cerrar con evidencia — `test/sync-inspect.test.js` y este documento — cubrir
   CA-01 a CA-12, ejecutar `npm test` y revisar diff, enlaces y posibles secretos.

La implementación se limitó a esas responsabilidades. Un commit local y una
publicación remota siguen siendo autorizaciones separadas.

## Riesgos, reversión y decisiones pendientes

- Las comprobaciones remotas pueden cambiar después de consultar; el informe es
  una observación fechada, no un certificado histórico inmutable.
- Inventario y reglas por ruta no capturan todos los cambios de significado;
  el contraste del código y el juicio del revisor siguen siendo necesarios.
- Texto sensible no reconocido por patrones exige revisión antes de persistir.
- Implementación reversible retirando la operación nueva y conservando `plan`;
  no hay migración ni escrituras de memoria que deshacer.
- La consulta real a GitHub se comprobó en un proyecto autorizado. Esta prueba
  puntual no demuestra disponibilidad permanente ni cubre todos los permisos,
  tamaños o estados posibles del proveedor. Mapas configurables, diffs acotados
  y checks del SHA de integración quedan para otra especificación.

## Evidencia de esta etapa

Verificación local del 2026-09-30 en `test/sync-inspect.test.js`: 51 pruebas nuevas
con GitHub simulado, más las 50 pruebas existentes. La integración de `doctor`
usa repositorios Git temporales reales y compara archivos e índice byte a byte.
No se consultó ni se modificó ningún repositorio remoto para estas pruebas.

La suite completa se volvió a ejecutar el 2026-10-01: 101 pruebas correctas,
sin fallos ni pruebas omitidas.

| Criterio | Evidencia automatizada |
| --- | --- |
| CA-01 | Identidad, repositorio/host explícitos, rama y dos SHAs distintos |
| CA-02 | PR abierto/cerrado, otra rama/repositorio/número, fecha o SHA inválidos |
| CA-03 | Reinspección con encabezado legado; registro intacto |
| CA-04 | Varias páginas, renombrados, eliminados, duplicados y límite de 150 |
| CA-05 | Sin CI, pendiente, neutral, omitido y adversos; errores de permisos |
| CA-06 | SHA de cabecera, procedencia, rechazo de otro SHA y deduplicación |
| CA-07 | Estructuras canónica/declarada, reglas, rutas desconocidas y ambigüedad |
| CA-08 | Secretos ficticios, instrucciones maliciosas, escapes y URLs inseguras |
| CA-09 | Repetición e integración con doctor real; bóveda, fuente e índice intactos |
| CA-10 | Formatos, estados, `--strict`, opciones y códigos de salida |
| CA-11 | Tiempo, tamaño de respuesta/informe, páginas, textos, checks y notas |
| CA-12 | Regresión completa de doctor, init, connect, status y sync plan |

### Consulta real de GitHub

El 2026-10-01 se ejecutó `sync inspect --json` sobre una memoria autorizada y
un PR fusionado explícito. La consulta repetida a las `12:19:18.834 UTC` obtuvo:

- 8 archivos esperados y 8 recuperados, sin omisiones; inventario completo.
- 5 comprobaciones aprobadas, ninguna adversa ni pendiente; cobertura completa.
- `alreadyReviewed: true`, coherente con el registro local de esa memoria.
- Estado `partial` por dos restricciones previstas: la descripción superó el
  límite de texto (`text-limit`) y una referencia externa se omitió
  (`unsafe-reference`). No se presentaron como errores de CI ni como evidencia
  completa sin restricciones.

Antes y después se compararon el estado Git y los bytes de los índices de fuente
y memoria, además del manifiesto, registro y una nota técnica: permanecieron
intactos. Esta comprobación puntual no equivale a comparar byte a byte todos
los archivos de un proyecto real; esa cobertura pertenece al fixture temporal
de la prueba automatizada de integración.

No se persistieron la descripción ni el inventario del proyecto consultado. La
biblioteca conserva independencia de ese proyecto y no necesita sus datos para
ejecutar las pruebas automatizadas.

Gate: aprobado con observaciones. El filtrado y los límites siguen requiriendo
juicio del revisor; la evidencia de CI del PR nunca sustituye revisar el código
integrado. La operación de inspección no editó notas, Skills, conexiones ni
automatizaciones. El usuario autorizó el commit local de esta entrega; no un
push. Esta base no incluye una operación de aplicación.

## Referencias oficiales

- [GitHub CLI: gh pr view](https://cli.github.com/manual/gh_pr_view): campos JSON
  seleccionables para metadatos; consultado el 2026-09-30.
- [GitHub REST: archivos de un PR](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files):
  inventario paginado; el proveedor limita la respuesta a 3000 archivos.
- [GitHub REST: check runs por referencia Git](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference):
  consulta por SHA y paginación de comprobaciones.
- [GitHub REST: estados de commit](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference):
  complemento para integraciones que publican estados en lugar de check runs.
