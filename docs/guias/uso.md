# Guía de uso de Agent Toolkit

Esta guía reúne la información técnica que antes estaba en el README principal.
Para conocer el propósito sin entrar en comandos, vuelve a la
[presentación del proyecto](../../README.md).

Si es tu primera prueba, empieza por [Primeros pasos](primeros-pasos.md): usa
ayudas y datos ficticios, sin instalar clientes ni ejecutar IA. El
[hito R1](../operacion/agent-toolkit-private-beta.md) separa esa base local de la validación
integrada, una instalación limpia y la publicación privada pendiente.

Los ejemplos que empiezan con `project-memory` presuponen que el comando está
instalado en tu equipo. Desde el repositorio también puedes ejecutarlos usando
`node bin/project-memory.js` seguido de la operación. `npm install` instala las
dependencias, pero por sí solo no instala el comando globalmente.

### Runtime de la base local actual

La base local RG3-A1b, autorizada el 2026-10-13, declara Node **24.x**
(`^24.0.0`) en package.json y en la raíz del lock. Sustituye el rango anterior
`>=20`: versiones 20, 22 y majors posteriores a 24 quedan fuera de este rango
declarado. No significa que se hayan probado y encontrado defectuosas.
La evidencia inicial es Node 24.14.1 en macOS/arm64, no toda la rama 24.x.

Antes de actualizar una instalación, comprueba su versión de Node y el lock
revisado; instala con `npm ci --ignore-scripts` usando configuración npm sin
credenciales innecesarias. No hay un paso autorizado de actualización del equipo,
instalación global o publicación. Este cambio local no altera la beta histórica.

El lector interno `src/memory-connection-toml.js` recibe bytes explícitos y
`{ mcpName }`, no rutas. Usa TOML 1.0.0 y solo devuelve campos directos de una
tabla estándar propia: command, args, cwd, enabled_tools y enabled. Los campos
ausentes siguen ausentes; no inventa enabled=true ni rellena argumentos.
Una entrada incompleta puede ser observada, pero no queda admitida por el plan.

El informe distingue observed, absent, blocked e invalid. Su SHA-256 corresponde
a los bytes suministrados y sus rangos son índices UTF-16 del texto JavaScript,
no offsets de bytes UTF-8. evidence=provided-bytes y byteSyntaxVerified no
acreditan origen, lectura local/nativa, runtime ni autorización.
No devuelve configuración ajena ni diagnósticos crudos del parser. Los controles
de contenido sensible son heurísticos, no una garantía de detectar todo secreto.

Esta base fija toml-eslint-parser 1.0.3 y eslint-visitor-keys 5.0.1; no convierte
el documento entero a un objeto ni implementa un editor TOML. No existe una
opción pública para llamar al lector: connect/status/CLI conservan su código
anterior. La recolección completa, integración y escritura siguen pendientes en
[RG-3](../memoria/project-memory-mcp-integration.md), con sus autorizaciones separadas.

### Recolector aislado de configuración (RG3-A1c)

El módulo interno `src/memory-connection-files.js` expone
collectMemoryConnectionConfiguration con homeDirectory, configurationPath y
mcpName explícitos. configurationPath debe ser exactamente
homeDirectory/.codex/config.toml; no acepta un archivo arbitrario ni deduce HOME/cwd,
ni consulta cuentas ni arranca un cliente. Esta etapa solo se prueba con hogares
temporales ficticios y no es una operación pública disponible en la CLI.

Comprueba padres sin symlinks, propiedad y permisos POSIX, archivo regular del
usuario con un solo enlace y modo exacto 0600. Los padres propios no admiten
escritura por grupo/otros ni bits especiales. Solo antes del hogar se permite
un ancestro compartido de root con modo exacto 1777. No corrige permisos ni crea
directorios. La ausencia de .codex/config.toml se revalida; la ausencia del hogar
o un error de acceso bloquean, no son una instalación que se pueda inventar.

Abre con solo lectura, no-follow y nonblocking; lee hasta el tamaño observado
con máximo 1 MiB y bloques de 64 KiB, sin byte extra al EOF. Revalida nombre,
descriptor y padres antes y después; intenta cerrar una vez incluso al fallar.
Un fallo de cierre bloquea y no acredita que el descriptor haya quedado cerrado.
Una carrera observable bloquea sin reintentos ni sobrescrituras. Esto no es un
openat atómico, un bloqueo contra otros editores o un sandbox; las ACL y carreras
no observables no quedan certificadas por estas comprobaciones.

observed con fileState=present y entryState=absent significa que se leyó el archivo
pero no tenía la entrada propia. absent con fileState=absent significa que el
archivo no existía; no acredita lectura de bytes. blocked elimina hashes/server
parciales y devuelve códigos fijos, no mensajes del sistema ni texto ajeno.

El SHA-256 corresponde a bytes exactos; metadataSha256 enlaza identidades y
metadatos observados, no una autorización o pin operativo aprobado. El informe
verificationScope=configuration-only no verifica la Skill, Node, dependencias,
precedencia efectiva ni lectura por una IA. Los dobles se marcan
simulated-local-file y no acreditan IO local nativo. Configuración real, conexión
de la CLI, escritura, commit y publicación requieren sus permisos independientes.

### Inspector aislado de la Skill (RG3-A1d)

El módulo `src/memory-connection-skill.js` expone inspectMemoryConnectionSkill
con descriptor y expectedSkillSha256 explícitos. Antes de IO reconstruye el
descriptor A1a y valida el pin; no toma otra ruta por HOME, cwd o descubrimiento.
La huella debe proceder de una revisión previa, no copiarse a ciegas del archivo
que el propio inspector acaba de encontrar. Comparar bytes no concede permisos.

El único enlace permitido es home/.agents/skills/<nombre>, propiedad del usuario,
apuntando mediante texto absoluto exactamente a vault/07-AGENTES/skills/<nombre>.
readlink solicita bytes y decodifica UTF-8 estricto; no admite sustituciones de
caracteres inválidos. Un destino relativo/ajeno/ocupado da conflict sin seguirlo
ni leer contenido ajeno. Padres o metadatos inseguros bloquean. Un origen esperado
faltante bloquea incluso si el enlace propio está roto; no se repara nada.

Solo lee el SKILL.md exacto del origen, regular, del usuario, modo 0600 y con
un enlace, máximo 128 KiB y bloques de 64 KiB limitados al tamaño inicial.
Revalida padres, archivo y enlace antes/después y tras cerrar. Una carrera
detectable, límite, error de cierre o hash distinto bloquean sin publicar una
huella sustituta, crear enlaces, sobrescribir Skills o reintentar.

matched significa enlace exacto y bytes coincidentes con el pin proporcionado.
absent significa destino ausente revalidado, pero fuente revisada comprobada;
no se debe confundir con Skill creada/cargada. sourceSha256/metadataSha256 solo
se publican en estas dos observaciones; resolvedSource solo en matched.
conflict no lee SKILL.md; blocked/invalid no entregan hashes o datos parciales.

El reporte verificationScope=skill-installation-only separa evidencia local
de simulated-local-skill. No interpreta instrucciones ni valida frontmatter,
formato, referencias o seguridad semántica: incluso bytes vacíos/binarios con
un pin coincidente no son prueba de una Skill utilizable. skillFormatVerified,
skillLoadedVerified, runtimeVerified, nativeReadVerified y autorización siguen
false. Tampoco se certifican ACL, atomicidad openat o carreras invisibles.

Esta base se desarrolla con fixtures propios. No instala ni edita la Skill real,
integra comandos públicos o verifica Node/dependencias; ese siguiente alcance
requiere su especificación y permiso separados. No hay commit ni push implícitos.

### Inspector aislado de artefactos base (RG3-A1e)

El módulo interno `src/memory-connection-artifacts.js` expone
inspectMemoryConnectionArtifacts con descriptor y expectedHashes explícitos.
El descriptor A1a debe conservar su identidad completa. expectedHashes exige
nodeSha256, binSha256, manifestSha256, packageJsonSha256 y packageLockSha256:
cinco huellas SHA-256 revisadas antes, no pins aprendidos del resultado.

Solo lee el Node declarado, el bin propio, el manifiesto dentro de la bóveda,
package.json y package-lock.json del Toolkit declarado. Las raíces de Toolkit
y bóveda deben ser disjuntas. Comprueba las cinco rutas antes de abrir cualquiera,
sin descubrir rutas por HOME/cwd/PATH ni recorrer node_modules. Rechaza enlaces
simbólicos, hardlinks, tipos especiales, alias físicos, propietarios o permisos
inseguros; no resuelve silenciosamente un Node instalado mediante symlink.

Node debe ser regular, de root o del usuario y con lectura/ejecución del dueño,
sin escritura de grupo/otros ni bits especiales. Bin y metadatos son del usuario,
modo exacto 0600/0644; manifiesto solo 0600. Los padres propios no admiten
escritura de grupo/otros o bits especiales; root 1777 solo fuera de esas raíces.
No corrige permisos ni interpreta el contenido leído.

Lee Node hasta 256 MiB, bin/manifiesto/package.json hasta 512 KiB cada uno y lock
hasta 2 MiB, con total máximo 260 MiB. La suma máxima por rol es 259.5 MiB;
el total es un control conservador adicional. Reutiliza un único buffer de
64 KiB, sin reservar el binario completo ni pedir un byte extra al EOF. Revalida
el lote antes de cada apertura y al final, además del archivo abierto y sus
padres durante esa observación. Intenta un cierre por archivo; no reintenta ni
repara carreras. No certifica ACL, atomicidad openat o carreras ABA invisibles.

matched entrega las cinco huellas coincidentes, metadataSha256 y bytesRead.
blocked/invalid eliminan hashes y metadatos parciales; no revelan una huella
sustituta, contenido o errores crudos. bytesRead conserva bytes confirmados por
read aunque el lote falle, pero no es una auditoría de IO ante excepciones.
El reporte copiado/congelado distingue local-artifact-files de simulaciones,
con verificationScope=base-artifacts-only. Pins coincidentes no acreditan
versión/arquitectura de Node, manifiesto válido, imports/dependencias instaladas,
licencias, seguridad semántica, autorización ni funcionamiento por un host MCP.

Esta base solo se probó con archivos ficticios: el Node falso nunca se ejecuta
y los JSON opacos no se interpretan. No hay comando CLI, admisión de runtime,
instalación, cambio de conexiones reales o integración automática con el plan.
Los siguientes alcances conservan sus permisos y puertas de
[RG-3](../memoria/project-memory-mcp-integration.md), incluido el cierre pendiente de RG-2.

### Validador puro del manifiesto (RG3-A1f)

El módulo interno `src/memory-connection-manifest.js` expone
validateMemoryConnectionManifest con descriptor, manifestBytes y
expectedManifestSha256. Recibe bytes proporcionados, no una ruta que deba abrir:
el pin revisado se compara antes de interpretar JSON. No aprende otra huella del
contenido rechazado ni confiere permisos por coincidir.

Comprueba el esquema propio 1.0.0, la política de solo lectura y las declaraciones
de repositorio/bóveda/MCP/Skill contra el descriptor. Las rutas relativas se
resuelven desde el padre del manifiesto explícito, nunca desde cwd/HOME. Los ID
de agentes deben ser únicos y codex debe aparecer una vez, enabled=true y con
skillName explícito coincidente. Otros agentes y automatizaciones pueden estar
declarados, pero no se admiten, conectan o ejecutan por validar este documento.

Acepta string Unicode válido, Buffer o Uint8Array ordinario; copia datos sin
getters/iteradores personalizados. Rechaza subclases/proxies/buffers compartidos,
UTF-8/BOM/JSON inválidos, claves duplicadas/peligrosas y datos sensibles según
la heurística existente. Límites previos al esquema: 512 KiB UTF-8, profundidad
64, 30000 nodos y 256 elementos por array. No modifica el esquema genérico ni
garantiza detectar todo secreto. Usa el esquema confiable cargado al importar el
módulo; un $schema declarado no selecciona ni descarga esquemas externos.

validated solo acredita reglas de bytes/declaraciones. Devuelve manifestSha256
y descriptorSha256; blocked/invalid no entregan huellas o éxitos parciales,
contenido o errores crudos. El reporte copiado/congelado distingue
evidence=provided-bytes y verificationScope=manifest-declarations-only, no IO
local ni conexión nativa. Solo los facts de esquema/seguridad/coincidencia
declarados son true; identidad física, manifiesto operativo, Node/dependencias,
autorización, ejecución y aplicación siguen false.

No hay integración CLI, collector real, actualización de Obsidian ni unión
automática al plan. La admisión operativa de runtime/dependencias y el cierre
del piloto conservan sus alcances y permisos de
[RG-3](../memoria/project-memory-mcp-integration.md).

### Coherencia de paquete y lock proporcionados (RG3-A1g)

El módulo interno `src/memory-connection-package.js` expone
validateMemoryConnectionPackage. Recibe exactamente descriptor, packageJsonBytes,
packageLockBytes, expectedPackageJsonSha256 y expectedPackageLockSha256.
No recibe rutas para abrir: copia ambas capturas y exige dos pins SHA-256
revisados antes de interpretar cualquiera de los JSON. El descriptor no concede
permiso ni demuestra procedencia; un rechazo no devuelve huellas sustitutas.

La primera base admite lockfileVersion=3 y compara name/version entre paquete,
cabecera del lock y packages[""]. Compara literalmente los nombres y
especificadores de dependencies raíz, sin depender del orden. Campo ausente
equivale a mapa vacío; null, arrays, valores no cadena o contradicciones bloquean.
engines.node debe coincidir si se declara; si falta en ambos, no queda verificado.
Los perfiles raíz de desarrollo/opcionales/peers no vacíos y workspaces,
overrides o dependencias agrupadas quedan fuera de esta base y bloquean.

Acepta string UTF-8 válido, Buffer o Uint8Array ordinarios copiados, sin invocar
getters o iteradores del llamador; rechaza proxies, subclases y backing compartido.
Límites por archivo: 512 KiB para paquete y 2 MiB para lock, 2.5 MiB combinados;
JSON estricto sin BOM/duplicados/claves peligrosas, profundidad 64, 30000 nodos,
arrays de 256 elementos y presupuesto de metadatos de 2000000 bytes por documento.
Este último puede bloquear antes del máximo de bytes del archivo. Dependencias:
256 entradas, nombres de 256 unidades UTF-16, especificadores de 1024; motor
1024 e identidad 256, sin controles/espacios externos. No se amplían utilidades
compartidas ni dependencias. La heurística sensible bloquea hallazgos, sin
garantizar ausencia absoluta de secretos.

consistent significa exclusivamente coincidencia de declaraciones raíz.
El reporte copiado/congelado entrega los tres hashes y facts de esa comparación;
blocked/invalid devuelven hashes null, un código fijo y ningún éxito parcial.
evidence=provided-bytes y verificationScope=package-root-declarations-only:
no muestra contenido, versiones, diferencias ni errores originales. No evalúa
rangos: incluso una versión fijada incompatible en otra entrada del lock puede
coexistir con consistent. No certifica el grafo, integridad del árbol instalado,
runtime de Node, licencias, lectura local/nativa, autorización o ejecución.

No hay comando CLI, acceso a node_modules, instalación, resolución de imports,
descarga o ejecución de npm/Node candidatos; URLs/file/git/scripts/bin/$schema
siguen siendo texto no interpretado. No se une al plan ni a A1e automáticamente,
ni modifica conexiones, Skills u Obsidian. La integración y la admisión real
conservan las puertas y permisos de [RG-3](../memoria/project-memory-mcp-integration.md).

### Diagnóstico conjunto de declaraciones (RG3-A1h)

El módulo interno `src/memory-connection-diagnostic.js` expone
summarizeMemoryConnectionEvidence. Recibe schemaVersion=1.0.0, descriptor,
reviewedPins y components, no rutas para inspeccionar. Reúne cinco proyecciones
cerradas: configuration, skill, artifacts, manifest y package. null significa
que no se aportó ese informe, no un resultado satisfactorio o instalación ausente.
Las proyecciones se preparan explícitamente según el
[contrato de A1h](../memoria/project-memory-mcp-integration.md); las salidas brutas de los
inspectores no se aceptan descartando campos/facts a escondidas.

Cada proyección declara bindingSha256 del descriptor. Contrasta esas declaraciones,
identidades y siete pins previamente revisados; los cinco hashes de artefactos
deben concordar con manifiesto/paquete cuando esos resultados estén presentes.
No aprende pins del propio resultado ni autentica el origen de los informes.
La configuración observada debe describir el tuple protegido y exactamente
las nueve lecturas, sin duplicados. No completa una tabla parcial, acepta env
extra, transforma legacy o genera una receta. enabled=false queda pendiente;
no hereda el true por defecto de otra herramienta ni confunde ese estado con
el false del descriptor propuesto.

Estados: invalid para entrada fuera del contrato; blocked para contradicciones,
impedimentos, límites o contenido sensible; incomplete para datos faltantes,
configuración/Skill ausente o servidor deshabilitado; coherent solo cuando las
cinco declaraciones son compatibles y el servidor se declara habilitado.
Un impedimento domina a un pendiente. Los componentes conservan orden fijo y
usan únicamente estados/códigos propios, sin rutas, nombres, pins individuales,
server, razones/facts ajenos o mensajes originales.

Solo coherent entrega descriptorSha256 y bundleHash, calculado canónicamente
sobre la envoltura copiada; no equivale a permiso. evidence=declared-reports y
verificationScope=cross-report-declarations-only. declarationsLinked es el único
hecho positivo de comparación; procedencia, snapshot atómico, vigencia, lectura
local/nativa, Skill cargada, runtime, árbol instalado y autorización siguen false.
Incluso informes fabricados compatibles pueden pasar: no se prueba su origen.

Copia inerte, reporte congelado y máximos de 128 KiB de entrada total/reporte,
profundidad 64, 30000 nodos y arrays de 256 elementos. Las strings observadas de
server/rutas tienen hasta 4096 unidades UTF-16, sin controles o espacios externos.
Tipos/extras de proyección se rechazan; una tabla server observada no reconocida
se clasifica como conflicto. La heurística sensible no garantiza detectar todo
secreto. No se modifican ni congelan objetos del llamador.

No hay nuevo comando público ni invocación de recolectores/validadores previos,
plan, cliente IA o candidatos. Sin IO destino, instalación, activación,
migraciones o cambios de configuración/Obsidian. Este módulo no cierra RG-2,
admite Node/dependencias o sustituye la prueba nativa de cambios de roots.

Núcleo personal y reutilizable para conectar agentes con distintos proyectos sin mezclar su contexto específico. Reúne Skills, perfiles especializados y el contrato base del sistema de memorias de proyecto.

### Recorrido de prueba conjunto (RG3-A2a)

`test/memory-connection-flow.test.js` reúne los módulos internos anteriores en
un proyecto temporal totalmente ficticio. Se ejecuta con
`node --test --test-concurrency=1 test/memory-connection-flow.test.js`.
No es un comando de conexión ni inspecciona tu configuración o tu memoria.
Node, bin, Skill y demás archivos de la prueba son fixtures inertes.

Comprueba el recorrido válido, ausencias, servidor deshabilitado, huellas
incorrectas, bytes alterados, declaraciones contradictorias y mezcla de proyectos.
Un adaptador explícito dentro del test proyecta los cinco informes sin trasladar
sus facts. Los validadores reciben los bytes previstos del fixture, vinculados
por huellas con los artefactos inspeccionados: no es una captura atómica.
coherent continúa siendo coincidencia de declaraciones, no certificación de una
conexión real, permiso, runtime, Skill cargada o dependencias instaladas.

Los guards y snapshots del test revisan operaciones comunes y preservación de
los fixtures; no constituyen un aislamiento de seguridad general. Solo se limpia
la raíz temporal propia tras validar su identidad. Véanse contrato y evidencia
en [RG3-A2a](../memoria/project-memory-mcp-integration.md). No cierra RG-2, todo RG3-A2,
preview/status ni la integración pública; tampoco cambia Skills u Obsidian.

### Contrato simulado de vistas previas y estado (RG3-A2b)

`test/memory-connection-preview-status.test.js` es una especificación ejecutable
aislada: usa el plan y el diagnóstico reales con proveedores ficticios, sin IO.
Se comprueba con `node --test --test-concurrency=1 test/memory-connection-preview-status.test.js`.
El pequeño presentador y lector de opciones viven solo en el test; no son nuevas
funciones de la CLI ni leen tu configuración. Los dos contratos conservan sus
pins distintos: no se inventa una conversión o una admisión de dependencias.

La simulación distingue preview/unchanged de conexión operativa. Para status,
coherent se presenta como ok de declaraciones; ausencias/disabled como warning;
contradicciones como error. JSON indica simulation:true y nativeRead:not-tested;
strict solo cambia warning de status a código 1. Las vistas previas no aplican
cambios y rechazan --apply/--expect. El harness requiere una ruta ficticia
explícita, sin fallback a HOME/cwd ni inspección de archivos.

La CLI pública todavía rechaza --transport protected; se prueba ese rechazo
real antes de IO. Los resultados del harness no acreditan que los comandos
públicos ya ofrezcan la nueva presentación, ni cierran RG-2, todo RG3-A2,
CA-RG310 o RG3-I. El [contrato y evidencia](../memoria/project-memory-mcp-integration.md)
detalla qué es simulación, qué usa módulos reales y qué sigue pendiente.

## Estructura

La base aislada del [intermediario MCP de raíz fija](../memoria/project-memory-mcp-guard.md)
se ejecuta con `node bin/project-memory-mcp.js --manifest <manifiesto-absoluto>`.
Es un servidor STDIO para un host MCP, no un chat interactivo: no configura
clientes, no ejecuta modelos y no modifica la bóveda. Su catálogo contiene nueve
lecturas y las raíces del host no cambian el destino fijado por el manifiesto.
Las dependencias deben estar instaladas previamente con el lock; no usa npx ni
descarga paquetes al arrancar. Su adopción en clientes reales queda en RG-2;
connect/status todavía usan sus adaptadores anteriores.


- `skills/`: procedimientos reutilizables compatibles con el formato `SKILL.md`.
- `agents/codex/`: agentes personales de Codex en formato TOML.
- `agents/claude/`: subagentes personales de Claude Code en Markdown con frontmatter YAML.
- `docs/`: arquitectura, decisiones y guías del sistema reutilizable.
- `schemas/`: contratos verificables para manifiestos y configuraciones.
- `bin/`: puntos de entrada locales de `project-memory` y `agent-task`.
- `src/`: diagnósticos y operaciones seguras de la CLI.
- `test/`: pruebas automáticas con el ejecutor nativo de Node.js.

La arquitectura inicial del sistema de memoria está en [`docs/memoria/project-memory-system.md`](../memoria/project-memory-system.md). Su manifiesto se valida con [`schemas/project-memory.schema.json`](../../schemas/project-memory.schema.json).

## Skills disponibles

- `mcp-builder`: diseño y revisión de servidores MCP; conserva recursos de evaluación opcionales con requisitos propios.
- `differential-review`: revisión de seguridad de cambios concretos, con historia Git y evidencia; alcance y licencia en [Fuentes de las skills](../skills/fuentes-de-skills.md).
- `web-design-guidelines`: revisión de interfaces con las Web Interface Guidelines de Vercel Labs, fijadas en la skill con su licencia MIT.
- `frontend-design`: guía de diseño frontend de Claude Code Templates, con fuente y licencia registradas en [Fuentes de las skills](../skills/fuentes-de-skills.md).
- `ordenar-proyecto`: organiza archivos y carpetas y ayuda a ubicar archivos nuevos conservando sus referencias.
- `decision-records`: documenta decisiones confirmadas con contexto y consecuencias.
- `project-handoff`: prepara traspasos breves y verificables entre sesiones o agentes.
- `quality-gate`: puerta antes de un PR o de la revisión cruzada; revisa requisitos, riesgos y diff sobre la evidencia fresca de Superpowers.

El proceso de trabajo (diseñar, planificar, depurar, TDD y verificar) lo pone [Superpowers](../skills/superpowers-integration.md), obligatorio: `npx nexakit` lo instala en cada IA.
- `elegir-modelo`: recomienda y comprueba el modelo y el esfuerzo de Claude Code, Codex y Antigravity con el criterio de Anthropic: el esfuerzo es el por defecto de cada modelo salvo para iterar, verificar o trabajo crítico desatendido, y el modelo sube cuando hace falta saber más.

Las equivalencias de proceso y reglas de convivencia con el plugin opcional Superpowers están en [Integración y adaptación de Superpowers](../skills/superpowers-integration.md).

## Preparar un encargo para otro agente

`agent-task prepare` reúne los datos explícitos de una tarea y la recomendación
del selector v2 en un borrador para revisión y entrega manual. No interpreta
una necesidad libre mediante IA ni escoge datos faltantes por su cuenta.
No ejecuta otros clientes, cambia su modelo, consulta cuentas o guarda archivos.

Desde la raíz de la biblioteca puedes probar el ejemplo exclusivamente ficticio:

```bash
node bin/agent-task.js prepare \
  --task examples/task-prepare/task.example.json \
  --request examples/model-selection/request.preference.example.json \
  --catalog examples/model-selection/catalog.preference.example.json \
  --policy examples/model-selection/policy.preference.example.json
```

- Sin opciones de salida: resumen, sin el cuerpo o las rutas privadas del encargo.
- `--json`: el mismo resumen estructurado.
- `--show-brief`: borrador completo en el terminal; su contenido puede quedar
  en scrollback o logs. Es incompatible con `--json`.
- `--help`: ayuda sin leer documentos de tarea.

Solo `prepared-draft` entrega el borrador, nunca lo marca autorizado/listo.
`needs-info`, `blocked` e `invalid` conservan pendientes sin usar defaults,
otro proveedor o una API de pago. Los cuatro JSON deben indicarse explícitamente;
request/catalog/policy usan v2. Los catálogos y disponibilidades son declaraciones
revisadas, no una comprobación actual de tu cuenta. Los ejemplos no evalúan
modelos reales y sus fechas históricas no acreditan disponibilidad hoy.

Tutor conserva un paso y la autoría del usuario. Autónomo prepara un solo rol;
el proponente, ejecutor y revisor necesitan encargos/decisiones independientes.
Antes de entregar el texto, revisa el permiso directo, instrucciones vigentes,
base real y fuentes. Ninguna referencia o huella JSON acredita eso por sí sola.

El comando funciona localmente con `node bin/agent-task.js`; esta entrega no
lo instala globalmente. Detalles y límites en
[agent-task prepare](../agentes/coordinacion/agent-task-prepare.md) y el [ejemplo](../../examples/task-prepare/README.md).

## Comprobar huellas de una entrega

`agent-task verify` compara los bytes de los archivos enumerados en un contrato
ya revisado con sus huellas SHA-256 esperadas antes (`before`) o después
(`after`) de una entrega. Solo lee el contrato y esas rutas exactas; no ejecuta
comandos, no lee `.git`, no recorre directorios, no escribe ni envía nada.

```text
node bin/agent-task.js verify \
  --contract <contrato-revisado.json> --expect <sha256-registrado-al-revisar> \
  --source <raíz-del-proyecto> --handoff <carpeta-privada-del-lote> \
  --phase before
```

Los valores entre `<>` son marcadores, no rutas de ejemplo ejecutables.

- `--expect` es la huella de los bytes del contrato anotada durante su revisión;
  no se calcula ni se toma del propio contrato. Si no coincide, el resultado es
  `blocked` sin comprobar las raíces ni leer ninguna entrada listada. Si el
  contrato está dentro de una raíz, antes del pin solo se recorren los componentes
  de su propia ruta y se leen sus bytes.
- `--source` y `--handoff` son absolutas, físicas, distintas y no anidadas;
  handoff debe tener exactamente el modo 0700, sin bits setuid/setgid/sticky.
  No se aceptan HOME, la raíz del disco ni directorios `.git`, `.obsidian` o
  de configuración de clientes.
- Lecturas acotadas: contrato hasta 512 KiB; archivos observados hasta 8 MiB
  cada uno y 32 MiB en total por invocación (el contrato no cuenta en ese total).
  No se lee más allá del tamaño fijado; crecer o truncarse durante la lectura da
  `blocked`.
- `--json` entrega el mismo resumen estructurado; nunca incluye contenidos ni
  rutas físicas.

`matched` (exit 0) solo indica que los archivos listados coinciden en esa fase.
`mismatched` (1) señala hashes distintos, archivos ausentes o presentes de forma
inesperada. `blocked`/`invalid` (2) cubren pin distinto, recursos inseguros o
cambiados, límites y contratos inválidos. Ningún estado aprueba código,
pruebas, Git, modelos, consumo o permiso; los archivos no listados quedan sin
verificar y una expectativa mal revisada puede coincidir con una entrega
incorrecta. La revisión humana sigue siendo obligatoria.

Funciona en macOS/Linux con `node bin/agent-task.js`, sin instalación global.
Contrato y límites en [agent-task verify](../agentes/coordinacion/agent-task-verify.md); preparación de
datos ficticios en el [ejemplo](../../examples/task-verify/README.md).

## Perfiles disponibles

- `project_explorer`: explora repositorios en modo de solo lectura.
- `requirements_analyst`: convierte necesidades en requisitos comprobables.
- `solution_architect`: compara alternativas técnicas y sus consecuencias.
- `quality_reviewer`: detecta defectos, riesgos y pruebas faltantes.
- `docs_researcher`: consulta documentación oficial y versionada.
- `implementation_tutor`: guía implementaciones paso a paso sin sustituir al usuario.

Los perfiles de solo lectura lo son **por instrucción**, no por sandbox. Un
agente personal de Codex no puede fijar su propio `sandbox_mode`: hereda el
sandbox y las aprobaciones de la sesión que lo lanza, y el campo se ignora en el
archivo, así que no se incluye. Para una garantía real, ejecuta la sesión
principal con un sandbox de solo lectura. Con la sesión en `workspace-write`, un
agente que ignore su instrucción podría editar.

## Instalación local

Este repositorio es la fuente canónica. Sus componentes se instalan mediante enlaces simbólicos:

- Skills para Codex: `~/.agents/skills/`.
- Skills para Claude Code: `~/.claude/skills/`.
- Agentes para Codex: `~/.codex/agents/`.
- Agentes para Claude Code: `~/.claude/agents/`.

Los enlaces evitan copias divergentes: una actualización en esta biblioteca queda disponible para las plataformas conectadas después de reiniciar la sesión cuando sea necesario.

## Memorias de proyecto

Cada proyecto conserva por separado:

- su repositorio como fuente principal de verdad;
- una bóveda privada para contexto estable;
- un MCP de solo lectura;
- una Skill específica que aplica búsqueda progresiva;
- reglas de escritura y sincronización controladas.

`Agent-Toolkit` contiene únicamente componentes reutilizables. No almacena el conocimiento privado de los proyectos.

## Diagnóstico de una memoria

La primera herramienta ejecutable es `project-memory doctor`. Inspecciona una memoria sin modificarla.

```bash
npm install
node bin/project-memory.js doctor /ruta/a/la/memoria
```

Opciones principales:

- `--manifest <ruta>`: utiliza un manifiesto concreto.
- `--json`: devuelve un informe estructurado.
- `--strict`: trata las advertencias como error.

La guía completa está en [`docs/memoria/project-memory-doctor.md`](../memoria/project-memory-doctor.md).

## Crear una memoria

`project-memory init` genera una vista previa segura de una memoria canónica:

```bash
project-memory init /ruta/al/proyecto-memory \
  --project-id mi-proyecto \
  --project-name "Mi Proyecto" \
  --source /ruta/al/repositorio
```

La creación solo ocurre al repetir el comando con `--apply`. No sobrescribe archivos distintos ni configura Git, MCP o agentes por su cuenta. Consulta [`docs/memoria/project-memory-init.md`](../memoria/project-memory-init.md) para ver el contrato completo.

## Conectar un agente

`project-memory connect` inspecciona y prepara la Skill, el MCP y la política de
solo lectura de una plataforma concreta:

```bash
project-memory connect /ruta/a/proyecto-memory --agent codex
project-memory connect /ruta/a/proyecto-memory --agent claude
```

La vista previa no modifica el equipo. Después de revisarla, `--apply` crea
únicamente los elementos ausentes y se detiene ante enlaces o servidores
homónimos diferentes. La guía completa está en
[`docs/memoria/project-memory-connect.md`](../memoria/project-memory-connect.md).

## Consultar el estado

`project-memory status` reúne el diagnóstico de la bóveda y la comprobación de
todas las conexiones habilitadas:

```bash
project-memory status /ruta/a/proyecto-memory
```

La orden es de solo lectura. Admite `--agent`, `--json` y `--strict`, y distingue
entre un sistema saludable, una conexión pendiente y un conflicto. Consulta
[`docs/memoria/project-memory-status.md`](../memoria/project-memory-status.md) para ver el
contrato completo.

## Planificar una sincronización

`project-memory sync plan` detecta los Pull Requests de GitHub que fueron
fusionados en la rama configurada y todavía no aparecen como revisados en el
registro Markdown de la memoria:

```bash
project-memory sync plan /ruta/a/proyecto-memory
```

La orden es de solo lectura: no modifica notas, no registra PR y no crea commits.
Admite `--limit`, `--json` y `--strict`. Consulta
[`docs/memoria/project-memory-sync.md`](../memoria/project-memory-sync.md) para ver el contrato
completo.

## Inspeccionar un cambio fusionado

`sync inspect` reúne evidencia de un PR explícito y sugiere áreas de la memoria
que conviene revisar. Usa el repositorio y la rama declarados en el manifiesto:

```bash
project-memory sync inspect /ruta/a/proyecto-memory --pr 42
project-memory sync inspect /ruta/a/proyecto-memory --pr 42 --json --strict
```

El número `42` es un ejemplo: sustitúyelo por el PR que quieras inspeccionar.
Requiere GitHub CLI (`gh`) disponible y autenticado para ese repositorio.
No descarga código ni diffs, no ejecuta pruebas y no modifica notas ni el registro.
Los estados `ready`, `partial` y `blocked` describen la evidencia disponible;
`ready` no aprueba el código ni autoriza actualizar Obsidian. Con `--strict`,
`partial` y `blocked` devuelven código 1. Admite `--max-files` (200 por defecto).
Consulta el [contrato y la evidencia local](../memoria/project-memory-sync-inspect.md).

## Registrar una revisión terminada

`sync record` deja constancia de una conclusión ya revisada. Su vista previa
consulta GitHub, verifica el PR fusionado y comprueba el registro y los cambios
locales, sin escribir archivos:

```bash
project-memory sync record /ruta/a/proyecto-memory \
  --pr 42 --outcome no-documentation-change --reviewed
```

Si el resultado es correcto y autorizas guardar la fila, repite la orden con
`--apply`. Si actualizaste notas, declara un resumen y sus rutas exactas:

```bash
project-memory sync record /ruta/a/proyecto-memory \
  --pr 42 --outcome documentation-updated --reviewed \
  --summary "Actualizar el contrato de integración" \
  --note "03-IMPLEMENTACION/Contrato de integración.md"
```

El PR, la ruta y la nota son ejemplos; usa las rutas permitidas de tu memoria.
Las notas deben estar editadas y revisadas antes: el comando no las redacta.
`--reviewed` declara una revisión semántica terminada; no certifica el código.
Admite `--manifest` y `--json`. No admite `--force`, `--commit` ni `--push`.

Para registrar una revisión nueva exige comprobaciones completas y satisfactorias;
se detiene ante archivos ajenos, conflictos, enlaces inseguros o patrones de
secretos. Repetir el mismo resultado conserva la fila y su fecha.
**No edites ni sincronices la memoria durante `--apply`**: su bloqueo coordina
esta herramienta, no Obsidian ni otros editores.

La nueva base está implementada, probada y aprobada para su commit local;
su publicación está pendiente. Consulta [el contrato y sus límites](../memoria/project-memory-sync-record.md)
antes de aplicarla sobre una memoria real. No añade archivos a Git ni hace push.

## Aplicar una propuesta revisada de notas

`sync apply` no redacta notas: valida un JSON con su contenido completo, las
rutas existentes, los archivos fuente del PR y las huellas de sus versiones.
Guarda ese JSON fuera de la bóveda y prepara primero una vista previa:

```bash
project-memory sync apply /ruta/a/proyecto-memory \
  --proposal /ruta/a/propuestas/cambio-42.json --json
```

Revisa las diferencias y el significado contra el repositorio. Solo después
de autorizar ese plan concreto repite la orden con su `planId`:

```bash
project-memory sync apply /ruta/a/proyecto-memory \
  --proposal /ruta/a/propuestas/cambio-42.json \
  --apply --reviewed --expect "HUELLA_SHA256_DEL_PLAN_REVISADO"
```

Las rutas y la huella son ilustrativas. Exige Git limpio, salvo notas declaradas
que ya coincidan con la propuesta, PR fusionado y CI completo satisfactorio.
**Pausa Obsidian y la sincronización mientras aplicas.** El bloqueo se comparte
con `sync record`, pero no controla otros editores.

Un fallo entre notas puede devolver `partial` con `wrote: true`: revisa las
rutas aplicadas, satisfechas, pendientes e inciertas. No hay rollback automático.
El comando no modifica el ledger, staging, commits, conexiones ni Skills.
`sync record` y el respaldo Git se realizan por separado y con su autorización.

La base está implementada, probada y revisada para entrega local; no se ha
publicado ni aplicado sobre una memoria real. Consulta el
[contrato JSON, límites y evidencia](../memoria/project-memory-sync-apply.md) antes de usarla.

## Límites

- No guardar secretos, credenciales, tokens ni datos personales.
- No incluir conocimiento exclusivo de un proyecto.
- Mantener las instrucciones específicas dentro del repositorio o memoria de cada proyecto.
- Revisar y validar cada componente antes de instalarlo.
- Mantener los perfiles generales en modo de solo lectura salvo que exista una necesidad y autorización claras.

## Versionado

La biblioteca se versiona con Git y se respalda en un repositorio privado de
GitHub. Esta publicación manual no añade creación de remotos a la CLI.

## Crear un proyecto limpio

La primera ejecución de `npx nexakit` pregunta «¿Proyecto limpio o ya empezado?». El camino «Ya empezado» prepara
el código existente como antes. «Proyecto limpio» ofrece frontend, backend, base de datos y app móvil; cada parte
permite «No quiero». Con una sola parte se usa la raíz; con varias, `frontend/`, `backend/` y `movil/`.

En una carpeta con archivos, el modo limpio exige una subcarpeta nueva. Antes de crear muestra las órdenes exactas,
los archivos mínimos de FastAPI y los requisitos que falten; un requisito ausente bloquea la confirmación. Usa
los generadores oficiales actuales, instala dependencias y comprueba cada parte antes de continuar con skills,
memoria y agentes. No instala Node/Python del sistema, no levanta bases de datos ni despliega.

Python usa su propio `.venv`. PostgreSQL añade el controlador y `.env.example`; Supabase inicializa su configuración
y añade el cliente al frontend cuando existe, o al backend. Git y el primer commit son opcionales; dentro de otro
repositorio no se crea uno anidado. Lo ya creado se conserva al fallar: se informa la parte, la orden y el registro
`.agent-toolkit/creacion.log`, con los secretos evidentes tachados. No reejecutes sobre los archivos para intentar
sobrescribirlos: revisa el registro y prepara lo existente o usa otra carpeta nueva.

Las respuestas se conservan y no se repite el selector en ejecuciones posteriores. Los generadores trabajan en
una zona temporal propia dentro de `.agent-toolkit` y se trasladan los archivos sin sobrescribir destinos. Tras
un fallo, esa zona se conserva para recuperar lo generado; tras éxito se limpia. Ctrl+C durante una orden la
cancela y conserva lo creado. Véase la [prueba manual](proyecto-limpio-prueba-manual.md).
