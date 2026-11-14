# RG-3 — Integración portable del MCP protegido

## Estado y autorización

Especificación propuesta el 2026-10-12 (America/Bogota). El usuario autorizó
crear únicamente este documento y, posteriormente, registrar aquí la estrategia
TOML investigada. No constituye aprobación integral del diseño ni permiso
para implementar, instalar dependencias, migrar conexiones, consultar cuentas,
actualizar memorias, crear commits o publicar.

El 2026-10-13 el usuario aprobó registrar Node 24.x como objetivo inicial de
implementación y pruebas. Esa decisión documental no autoriza cambiar engines
ni adoptar el parser: la especificación global continúa propuesta.

El 2026-10-13 se autorizó también registrar la excepción de secuencia para
construcción/pruebas ficticias de RG3-A. Registrar la excepción no concede
implementación: esa autorización, las pruebas y la adopción de dependencias
siguen siendo permisos separados.

El mismo día se autorizaron por separado RG3-A1a (descriptor y plan puros) y
RG3-A1b (lector TOML puro, dependencias fijadas, engines y pruebas). Son bases
aisladas locales: no autorizan el recolector, rutas públicas, editor/aplicador,
configuración personal, memorias, clientes, commit o publicación. El alcance y
la evidencia de A1b están al final; la especificación global sigue propuesta.

Posteriormente se autorizó RG3-A1c en cuatro rutas para recolectar únicamente
configuración, con fixtures y sin integrar rutas públicas. No autoriza observar
Skills, runtime o dependencias ni aplicar sobre archivos reales.

El alcance posterior RG3-A1d autoriza únicamente el inspector de instalación de
Skill y pruebas ficticias en sus cuatro rutas; no concede validación de runtime,
activación, integración, cambios de memorias/Skills reales, commit o publicación.

RG3-A1e se autorizó por separado el 2026-10-13 y se verificó el 2026-10-14:
inspección de cinco archivos y pins explícitos, con fixtures y cuatro rutas.
No concede admisión semántica de runtime/dependencias, integración, inspección
de instalaciones personales, actualización de memoria, commit o publicación.

El 2026-10-14 se autorizó por separado RG3-A1f: validar bytes explícitos de un
manifiesto contra el esquema propio y el descriptor, con pruebas ficticias en
cuatro rutas. No concede recolección real, integración, admisión de Node o
dependencias, modificación de otros módulos/esquema ni commit/publicación.

Profundidad SDD: rigurosa, por afectar configuración compartida, identidad del
transporte y migraciones. Los requisitos siguientes son comportamiento deseado,
no funcionalidades disponibles. Las opciones nuevas no deben ejecutarse todavía.

**Puerta de integración/adopción:** activar rutas públicas de connect/status,
implementar RG3-B o aplicar sobre configuraciones reales requiere cierre
documentado de RG-2, incluido CA-RG12, aprobación del alcance y autorización
propia. La construcción y prueba ficticias de RG3-A pueden solicitarse antes
con los límites de la excepción documentada abajo. No sustituir la prueba
pendiente de cambios de roots en una misma sesión nativa por lecturas desde
dos chats o por un cliente sintético; RG-2 no queda cerrado por esta excepción.

## Problema y resultado esperado

El piloto utiliza un intermediario que fija la raíz desde el manifiesto y solo
expone nueve herramientas de lectura. Sin embargo, connect y status aún describen
el servidor filesystem directo. Reutilizar la herramienta en otro proyecto puede
preparar el transporte antiguo o tratar la conexión protegida como un conflicto.

La persona responsable necesita ver qué conexión tiene, preparar una conexión
protegida sin efectos laterales y aprobar una migración limitada a su servidor.
Una instalación configurada no equivale a una lectura comprobada por una IA.

Resultado propuesto: planificación reproducible, diagnóstico explícito y aplicación
controlada, sin depender de la carpeta donde se inició el cliente ni ejecutar
comandos nativos de IA para inspeccionar o registrar la ruta protegida.

## Base inspeccionada

- HEAD e659337; RG-1/RG-2 y este documento están locales y sin commit.
- src/connect.js registra npx con filesystem 2026.8.31. Su reconocimiento actual
  también acepta otras versiones del paquete; no sirve como prueba de identidad
  para una migración protegida.
- La vista previa actual de Codex/Claude invoca mcp get mediante un runner.
  RG-3 no debe heredar esa ejecución en la ruta protegida de Codex.
- src/status.js utiliza connectMemory con apply:false y agrega los componentes
  de Skill, MCP y política. Un resultado configurado no prueba tools/list o lectura.
- src/cli.js aún no admite las opciones nuevas propuestas aquí.
- RG-1 aporta bin, política, servidor y transporte; no se propone reescribirlos.
- RG-2 tiene lectura nativa comprobada en la app y lectura reportada desde un chat
  de Agent Toolkit. Su prueba nativa de cambios de roots y cierre completo siguen
  pendientes. Las observaciones de licencia/deprecación de RG-1 permanecen abiertas.

Fuentes locales: [connect](../../src/connect.js), [status](../../src/status.js),
[CLI](../../src/cli.js), [contrato connect](project-memory-connect.md),
[contrato status](project-memory-status.md), [RG-1](project-memory-mcp-guard.md)
y [piloto RG-2](project-memory-mcp-pilot.md). No se ejecutaron connect, status,
clientes nativos, pruebas ni consultas de cuentas al redactar esta especificación.

## Alcance por etapas

### RG3-A — Planificación y diagnóstico de Codex

Antes de cerrar RG-2, esta etapa es construcción y verificación aisladas,
no integración operativa. Sus capacidades deseadas son:

- Un descriptor protegido compartido por connect y status.
- Vista previa explícita con --transport protected y --agent codex.
- Inspección acotada de la configuración local de Codex, sin invocar su CLI.
- Clasificación de transporte protegido, legacy reconocido, desconocido o ausente.
- Identificación de conflictos y huella del plan antes de cualquier escritura.
- Diagnóstico de Codex que reconozca el intermediario sin fingir lectura nativa.

El descriptor, núcleo y recolector se desarrollan con entradas ficticias o
hogares temporales propios explícitos. El contrato de preview/status se prueba
con dobles de prueba; no se conectan estos módulos a los comandos públicos
actuales, su dispatch o imports de inicio antes de pasar la puerta RG3-I.
No usar HOME/configuración/memoria personales como entrada por defecto en las
pruebas ni ejecutar clientes reales para preparar fixtures.

### RG3-B — Aplicación y migración aisladas de Codex

- Aplicación explícita del plan revisado con --apply y --expect.
- Migración opt-in del servidor legacy exacto con --migrate-legacy.
- Preservación de configuración ajena, estado de Skill e idempotencia.
- Pruebas únicamente con hogares y bóvedas ficticios; no aplicación real por defecto.

Cada etapa necesita una autorización delimitada. Aprobar A no concede B.
La aplicación posterior sobre una configuración personal real se autoriza aparte.

### Decisión de secuencia: excepción aislada de RG3-A

- Estado: aceptada únicamente como cambio documental de secuencia.
- Fecha: 2026-10-13 (America/Bogota).
- Responsable de aprobación: usuario responsable del proyecto.
- Relacionado: [piloto RG-2](project-memory-mcp-pilot.md), CA-RG301 y CA-RG317.
- Reemplaza parcialmente: la dependencia inicial que exigía cerrar RG-2 antes
  de cualquier implementación de RG3-A. No reemplaza los criterios de RG-2 ni
  cambia su documento o memoria.

#### Contexto y alternativas

El piloto ya lee por MCP, pero falta la prueba nativa de cambios de roots dentro
de una misma sesión. Las herramientas disponibles en esta conversación no
exponen un mecanismo para emitir ese cambio. Eso delimita esta observación,
no demuestra que ninguna versión o interfaz de Codex pueda hacerlo.

| Alternativa | Ventaja | Costo o riesgo |
| --- | --- | --- |
| Mantener toda construcción a la espera de RG-2 | Conserva la secuencia inicial | Detiene también pruebas locales que no actúan sobre el host |
| Cerrar RG-2 por la lectura existente | Permitiría adopción inmediata | No aporta la evidencia nativa exigida; descartada |
| Construir RG3-A con fixtures y bloquear integración/adopción | Permite desarrollar la base sin actuar sobre conexiones reales | Exige impedir que código aislado se active por defecto o se anuncie como integrado |

#### Decisión, restricciones y seguimiento

Se acepta la tercera alternativa. Podrá solicitarse un encargo específico de
implementación/pruebas de A1/A2, con rutas, hogares ficticios y permisos explícitos.
Esta edición no autoriza ese encargo, instalar el parser, ampliar dependencias,
reducir engines, modificar conexiones, activar rutas operativas o publicar.

El código aislado no debe sustituir por import o dispatch el comportamiento
actual de connect/status. Se permite planificar candidatos en memoria, no
aplicarlos: el aplicador y la migración pertenecen a RG3-B. Al probar contratos
de CLI/servicios se usarán inyección o simulación local, no clientes nativos.

Los resultados de fixtures se registran como evidencia aislada de A, sin cerrar
CA-RG12 ni declarar configuración efectiva del host. Antes de RG3-I, RG3-B,
migración real, activación o publicación se requiere cierre de RG-2 y nuevas
autorizaciones de cada alcance. Si no puede demostrarse la separación de rutas
o aparecen lecturas/escrituras de recursos personales, detener el encargo.

### Fuera de esta primera base

- Implementación/migración de Claude, Gemini o Antigravity. Requieren especificación
  posterior y documentación oficial de sus variantes antes de modificar adaptadores.
- Cambiar el transporte predeterminado de conexiones existentes o nuevas.
- Iniciar/reiniciar clientes, activar MCP automáticamente o verificar auth/cuota.
- Cambiar modelos, consumo, permisos generales o reglas de tutor/autónomo.
- Modificar esquemas del manifiesto, RG-1, .obsidian o memorias reales. La única
  ampliación de dependencias autorizada es el par fijado de RG3-A1b.
- Distribución pública, certificación de licencias o compatibilidad universal.

## Interfaz propuesta y compatibilidad

Ejemplos conceptuales, no comandos disponibles en la versión actual:

```text
project-memory connect <memoria> --agent codex --transport protected --json
project-memory connect <memoria> --agent codex --transport protected --migrate-legacy --json
project-memory connect <memoria> --agent codex --transport protected --apply --expect <huella>
project-memory connect <memoria> --agent codex --transport protected --migrate-legacy --apply --expect <huella>
project-memory status <memoria> --agent codex --json
```

- Sin --apply, no se escribe ni arranca proceso alguno en la ruta protegida.
- --transport protected exige --agent codex en esta base; otros agentes se rechazan
  antes de inspeccionar su configuración o invocar un cliente.
- --migrate-legacy solo es válido con el transporte protegido. En vista previa
  autoriza preparar la propuesta, no aplicarla.
- --expect es SHA-256 de un plan canónico de versión cerrada; exige --apply.
  La aplicación protegida siempre exige la huella revisada, incluso si resulta
  unchanged. Una huella diferente bloquea sin mostrar cómo sustituirla a ciegas.
- Opciones duplicadas, incompletas, contradictorias o transportes desconocidos
  devuelven error de argumentos, sin efectos laterales.
- La ruta legacy de connect conserva su comportamiento y contrato actuales;
  no se convierte en una conexión con raíz protegida ni se aprueba de nuevo.
- status --agent codex emplea el nuevo inspector local. Otros adaptadores quedan
  fuera de esta base; no afirmar que status sin filtro deje de invocar todos los
  clientes por este cambio. Las guías recomendarán el filtro para esta verificación.
- Conservar los códigos existentes: argumentos inválidos 2; conflict/blocked/error 1;
  vista previa o unchanged 0. status mantiene warnings con 0 normal y 1 en strict.
- No llamar al resultado configured/connected una conexión operativa comprobada.

## Diseño propuesto

### Descriptor único y resolución portable

Construir command/args/cwd desde una instalación verificada de Agent Toolkit:
Node absoluto, bin/project-memory-mcp.js propio, --manifest absoluto y cwd de la
instalación. No deducir el bin desde el repositorio del proyecto consumidor,
process.cwd(), un PATH arbitrario o una ruta personal codificada en la biblioteca.

Resolver identidades físicas y comprobar bin, manifiesto, Skill y dependencias
locales admitidas. Aplicar las validaciones del manifiesto/política de RG-1 sin
arrancar el backend. No ejecutar el servidor para descubrir sus propias rutas
ni realizar descargas con npx como alternativa. Si la instalación no es segura
o compatible con la plataforma verificada, informar blocked.

El descriptor incluye exactamente las nueve lecturas de RG-1. No ampliar la lista
si el backend añade herramientas ni mantener una segunda lista divergente.
Una configuración reconocida usa exclusivamente ese bin y manifiesto: un script
homónimo, otra bóveda o argumentos adicionales no se consideran equivalentes.

### Plan e identidad de la configuración

Un núcleo puro recibe observaciones verificadas; un recolector local obtiene
solo los archivos permitidos. El recolector valida tipo, dueño, permisos,
componentes de ruta y límites antes de leer. No recorre cuentas ni credenciales.

El informe conserva los componentes y resumen existentes, añadiendo campos
versionados para transporte, evidencia, enabled, cambios propuestos y planHash.
Las acciones observables son create, unchanged, migrate o conflict. Añadir
summary.migrate no elimina los contadores actuales ni oculta cambios como unchanged.

El planHash vincula versión, agente, nombre MCP, rutas/identidades físicas,
huellas de manifiesto/bin/configuración, política exacta, estado enabled y destino
de Skill. No incluye tiempos volátiles ni valores secretos en el informe público.
El hash de la configuración completa detecta ediciones ajenas sin imprimirla.
No exportar la configuración completa, env, tokens, perfiles o bloques de terceros.

No fingir configuración efectiva si intervienen capas/overrides no inspeccionados.
En ese caso, indicar configuration-only o blocked según si puede establecerse
inequívocamente la propiedad del destino; no afirmar precedencia efectiva del host.

### Clasificación y diagnóstico

| Observación local | Plan protegido | status de Codex |
| --- | --- | --- |
| Entrada ausente y Skill segura | create, todavía sin aplicación | warning, missing |
| Descriptor, nueve herramientas y Skill exactos; enabled:true | unchanged | ok de configuración, lectura nativa not-tested |
| Descriptor exacto, enabled:false | unchanged; no activar por su cuenta | warning, disabled |
| Legacy exacto de la misma bóveda, sin opt-in | conflict; explicar migración | warning, legacy-direct; raíz fija no acreditada |
| Legacy exacto, misma bóveda y --migrate-legacy | migrate propuesto | warning hasta revisar/aplicar |
| Otro bin/manifiesto/bóveda, política excesiva o campos no admitidos | conflict | error |
| Archivo inseguro, TOML ambiguo, capas indeterminadas o falta de evidencia | blocked, sin escrituras | error con motivo acotado |

Legacy exacto significa el tuple revisado npx, -y, paquete 2026.8.31 y una única
raíz que coincide físicamente con esta memoria. No aceptar cualquier versión,
paquete sin versión, argumentos de shell, varias raíces o env adicional como
migración automática. Podrán evaluarse después como casos nuevos, no forzarlos.

Separar configuration-only, local-policy y native-read. status de esta base solo
produce evidencia de configuración local; native-read permanece not-tested.
Ni --json, ni strict ni un hash correcto prueban alcance efectivo en una IA,
disponibilidad del modelo, cuota o aislamiento del sistema operativo.

### Aplicación, permisos y conservación

Solo --apply con la huella revisada puede escribir. Recolectar otra vez y verificar
huellas, identidades y condiciones justo antes de aplicar; conflicto detectado
significa cero escrituras. Crear/migrar una entrada protegida con enabled:false,
visible en el plan. Activación y recarga posteriores quedan fuera de RG3-B.
Una entrada protegida ya habilitada y exacta conserva su estado sin reescritura.

Modificar únicamente la tabla propia mcp_servers.<nombre> y, si falta, crear el
enlace de Skill propio previamente revisado. Preservar byte por byte los bloques
ajenos, comentarios y finales de línea; no reserializar todo TOML, restaurar una
copia compartida antigua ni invocar codex mcp add/remove para hacerlo.

Límites iniciales propuestos: configuración 1 MiB, manifiesto 512 KiB y rutas
4096 caracteres; superar el límite bloquea sin lectura ilimitada. El archivo de
configuración debe ser regular, del usuario y modo 0600. No seguir symlinks,
hardlinks o componentes inseguros de esa configuración, ni arreglar permisos
ajenos silenciosamente. Permitir solo el enlace de Skill propio exacto después
de validar su origen y padres, no otros enlaces arbitrarios.

No reemplazar una Skill distinta, rota o de otra memoria. Ante una falta de
configuración, crear solo padres propios seguros y un archivo 0600; no alterar
directorios ya existentes para forzar compatibilidad.

Escritura acotada mediante temporal exclusivo seguro y sustitución verificada.
No presentar comprobaciones antes/después como compare-and-swap garantizado:
otros editores no respetan el bloqueo cooperativo. Una carrera observada exige
detenerse y revisar, nunca reintentar sobrescribiendo configuración nueva.

Si falla después de crear una Skill, eliminar solo el enlace recién creado cuando
su identidad/destino continúen coincidiendo. No borrar una Skill concurrente,
restaurar toda la configuración o afirmar una transacción entre dos recursos.
Informar aplicación parcial y resultado de cleanup sin ocultar un fallo adicional.

## Alternativas y decisiones pendientes

| Alternativa | Evaluación propuesta |
| --- | --- |
| Mantener npx y solo una allowlist | No resuelve la sustitución de raíz ni la identidad del transporte |
| Cambiar todos los defaults y agentes en una entrega | Demasiado amplio; dificulta revisar migraciones y evidencia |
| Intermediario explícito, Codex primero | Propuesta de esta base; preserva defaults y separa expansión futura |
| Usar mcp get/add de los clientes | No satisface la ruta sin ejecución nativa ni preservación byte a byte |

La estrategia documentada para esta propuesta es un parser completo con AST y
posiciones de origen, seguido de ediciones puntuales sobre el texto original.
No reserializar el documento ni usar la búsqueda por regex actual como validador.
Al registrar esta estrategia, la dependencia estaba pendiente de revisión y
autorización. RG3-A1b la adopta únicamente para el lector puro descrito abajo;
no implementa las ediciones por posiciones ni autoriza su aplicación.
Las formas que el editor acotado no soporte deben bloquear sin mutar, aunque
sean TOML válido para el parser.

### Estrategia TOML registrada — 2026-10-12

Un AST es una representación estructurada del documento: distingue tablas,
claves, valores y texto que solo se parece a un encabezado dentro de una cadena.
El candidato toml-eslint-parser documenta nodos con range/loc, claves resueltas,
tokens y comentarios. Esto permite proponer un editor por posiciones; no prueba
que conserve bytes o cubra nuestros casos sin las pruebas locales previstas.
[Fuente: AST de la versión 1.0.3](https://github.com/ota-meshi/toml-eslint-parser/blob/v1.0.3/docs/AST.md).

Procedimiento propuesto:

1. Leer el archivo bajo los límites y controles definidos, decodificar UTF-8
   estricto y verificar que la recodificación conserve sus bytes. No sustituir
   caracteres inválidos, normalizar Unicode o eliminar un BOM silenciosamente;
   BOM o codificación no admitida producen blocked en esta primera base.
2. Analizar el documento completo con dialecto TOML 1.0.0 explícito. No usar
   latest/next o el dialecto predeterminado del parser como contrato mutable.
   Invalidación sintáctica, duplicados o estructura ambigua bloquean; no se
   recupera un documento inválido para intentar una edición parcial.
3. Localizar la tabla estándar por la clave resuelta exacta mcp_servers y nombre
   del manifiesto, no por prefijos o texto de encabezados. La primera base edita
   solo una tabla explícita y sus campos directos admitidos. Arrays de tablas,
   declaraciones inline/dotted repartidas o subtablas de esa entrada producen
   unsupported/blocked si no puede demostrarse una edición propia inequívoca.
   Las construcciones válidas ajenas permanecen intactas.
4. Planificar parches mínimos de los valores propios o inserciones de campos
   faltantes. Validar índices enteros, límites, ausencia de solapamiento y orden
   de aplicación de derecha a izquierda. No reemplazar toda una tabla para
   evitar gestionar sus comentarios. Si un valor incluye comentarios que no
   pueden conservarse con el parche, bloquear en lugar de borrarlos.
5. Tratar range como posiciones del texto JavaScript, no como offsets de bytes
   UTF-8. Verificar esa semántica en la API fijada y convertir o aplicar slices
   sin partir caracteres. Probar acentos y caracteres astrales antes y dentro
   de la tabla; no asumir que número de caracteres y bytes son equivalentes.
6. Para una entrada nueva, insertar únicamente la tabla generada en un punto
   validado, con separadores explícitos en el plan. Conservar todos los bytes
   originales, incluidos LF/CRLF, comentarios y ausencia de salto final.
7. Volver a analizar el candidato completo. Comprobar que su entrada propia
   tiene exactamente el descriptor esperado y que los segmentos no editados
   conservan sus bytes. No convertir/reescribir valores ajenos para compararlos
   ni exportar el objeto completo de configuración a logs o informes.
8. Vincular esos parches, el dialecto y la versión del parser al planHash.
   Recolectar/revalidar antes de aplicar. Una diferencia de hash o identidad
   produce bloqueo, sin adoptar automáticamente la huella nueva.

Los errores del parser se traducen a códigos acotados; no reenviar mensajes que
incluyan fragmentos del archivo, valores o líneas con secretos. La posición
del error puede mostrarse sin su contenido. El límite de 1 MiB y la validación
de rangos no equivalen a una garantía de tiempo/memoria del parser: revisar
entradas patológicas y mantener explícitos los límites de la evidencia.

### Investigación inicial del candidato y compatibilidad

La consulta pública al registro npm durante la investigación devolvió
toml-eslint-parser 1.0.3, licencia declarada MIT y dependencia
eslint-visitor-keys ^5.0.0. El package.json de esa versión declara Node
^20.19.0 || ^22.13.0 || >=24.
[Fuente: metadatos del proyecto para 1.0.3](https://github.com/ota-meshi/toml-eslint-parser/blob/v1.0.3/package.json).

En la base de esta investigación, el Toolkit declaraba >=20, por lo que no podía adoptarse ese candidato
prometiendo sin cambios todo el rango existente. Node 24.14.1 usado en el piloto
está dentro del rango declarado; eso no demuestra compatibilidad ejecutada del
parser. En ese momento no se había instalado, importado ni probado el paquete.

El objetivo inicial Node 24.x queda aceptado en la decisión siguiente. Antes de
implementar debían aprobarse el alcance de adopción del parser y cualquier
reducción efectiva de engines. No seleccionar una versión antigua por inercia
ni omitir comprobaciones de runtime para eludir esa revisión.

La versión exacta, dependencias transitivas resueltas, integridad del artefacto,
licencia incluida en el paquete y observaciones de seguridad requieren revisión
antes de autorizar instalación con lock y sin scripts. La licencia declarada y
la documentación del repositorio no certifican por sí solas el tarball ni sus
transitivas. Aquella actualización documental no concedía añadir paquetes,
cambiar engines ni actualizar el lock. La aprobación específica posterior
de RG3-A1b delimita su adopción, sin extenderla al resto de RG3-A/B.

Esta base tampoco decide instalar en equipos nuevos ni cambiar la plataforma
admitida por RG-1. Revisión de licencias/deprecación y evidencia de runtime quedan
como puertas separadas antes de ampliar distribución o compatibilidad.

### Decisión de alcance: objetivo inicial Node 24.x

- Estado: aceptado solo como objetivo documental de RG-3.
- Fecha: 2026-10-13 (America/Bogota).
- Responsable de aprobación: usuario responsable del proyecto.
- Relacionado: [package.json actual](../../package.json), candidato TOML y CA-RG316.
- Reemplaza: ninguna decisión histórica ni el engines vigente.

#### Contexto y restricciones

El runtime inspeccionado es Node 24.14.1. El Toolkit todavía declara >=20,
mientras el candidato TOML admite rangos más específicos. Además, el lock actual
contiene dependencias con rangos como 20 || >=22, que no incluyen Node 21 aunque
el rango de la raíz sí lo haga. Estos metadatos no demuestran funcionamiento en
todos los runtimes; la evidencia previa de RG-1 es macOS/arm64 con Node 24.14.1.

#### Opciones consideradas

| Opción | Ventaja | Costo o riesgo |
| --- | --- | --- |
| Mantener >=20 sin matices | Evita anunciar una reducción | No refleja las restricciones de dependencias ni las pruebas existentes |
| Adoptar todo el rango declarado por el parser | Abarca ramas 20, 22 y 24 o posteriores | Requiere validar runtimes todavía no probados y resolver la compatibilidad global |
| Centrar la primera base en Node 24.x | Coincide con el entorno del piloto y limita la matriz inicial | Deja otras versiones pendientes; una reducción futura de soporte afecta consumidores |

#### Decisión y motivos

La primera base RG3-A/B se diseñará y probará con Node 24.x como objetivo.
Node 20, 22, 25, 26 y demás versiones quedan fuera de la evidencia inicial,
no declaradas defectuosas o incompatibles por esa ausencia de pruebas.
No implica actualizar la máquina del usuario: el runtime observado ya es 24.x.

#### Consecuencias y seguimiento

Se obtiene una matriz inicial acotada; no se certifican todos los minors 24.x,
plataformas o dependencias antes de probarlos. Si se propone reducir engines,
el rango posible ^24.0.0 debe revisarse y autorizarse explícitamente, con pruebas,
guía de migración y correspondencia en el lock. No se aplica ahora ni se promete
que la compatibilidad global quede resuelta por cambiar una cadena de versión.

Al registrar esta decisión, package.json conservaba >=20. La adopción y el cambio
explícito posterior a ^24.0.0 se detallan en RG3-A1b; no acreditan el cierre global
de CA-RG316. Ampliar la evidencia
a otra versión de Node requiere revisión propia; no adoptar un runtime nuevo
automáticamente. CA-RG301 y el cierre nativo de RG-2 permanecen obligatorios para
integración/adopción; la construcción ficticia de A se rige por CA-RG317.

## Criterios de aceptación y pruebas previstas

Los criterios globales siguen pendientes de cierre integral. Las evidencias
aisladas A1a/A1b no sustituyen las pruebas del recolector, editor, CLI o host.

| ID | Resultado observable | Verificación prevista |
| --- | --- | --- |
| CA-RG301 | RG2-05/CA-RG12 cerrados antes de integración/adopción, RG3-B o publicación; permisos separados | Evidencia fechada del piloto y revisión humana; construcción ficticia A limitada por CA-RG317 |
| CA-RG302 | Vista previa protegida no escribe, arranca procesos ni descarga | Fixtures con spies de spawn/runner y snapshots de archivos |
| CA-RG303 | Descriptor propio funciona desde cwd distinto y rutas con espacios | Tests de resolución desde otra carpeta, sin proyecto personal codificado |
| CA-RG304 | El piloto protegido exacto ya instalado se reconoce como unchanged | Fixture del tuple RG-2 con nueve herramientas y Skill correcta |
| CA-RG305 | Legacy no migra sin opt-in ni acepta otra versión/raíz/env | Matriz de coincidencia exacta, argumentos extra y paquetes sin versión |
| CA-RG306 | Aplicar exige hash vigente; cambios desde la vista previa bloquean | Cambios de config/manifiesto/bin/padres entre plan y apply |
| CA-RG307 | Solo cambia la tabla propia; archivo seguro y Skill ajena intacta | Comparación de bytes ajenos, modos y varios servidores ficticios |
| CA-RG308 | Configuración insegura/ambigua/oversized bloquea | Symlink, hardlink, dueño/modo incorrectos, duplicados y límites exactos |
| CA-RG309 | Configurado no se presenta como lectura nativa | JSON/texto distinguen transporte, enabled y evidence:not-tested |
| CA-RG310 | status conserva agregación/códigos; reconoce legacy y disabled | Tests unitarios y CLI con strict, json, ausente, conflicto y agente deshabilitado |
| CA-RG311 | Repetir aplicación exacta es unchanged y no reescribe | Dos aplicaciones aisladas con hashes/mtime y cero spawn |
| CA-RG312 | Fallo/cleanup/carrera no sobrescriben recursos nuevos ajenos | Fallos inyectados antes/durante aplicación y cambio concurrente de Skill |
| CA-RG313 | Errores e informes no exponen secretos ni config ajena | Marcadores sensibles ficticios en bloques ajenos, env y errores inyectados |
| CA-RG314 | Defaults y adaptadores no autorizados se preservan | Regresión de connect/status/CLI y exclusión explícita de aplicación real |
| CA-RG315 | Parser y parches preservan bytes y bloquean formas no admitidas | Fixtures de multiline con encabezados falsos, comentarios, claves entrecomilladas, duplicados, inline/dotted, LF/CRLF, sin salto final, acentos y caracteres astrales; reparse del candidato |
| CA-RG316 | Compatibilidad y dependencia fijadas sin reducir soporte silenciosamente | A1b adopta el par exacto y ^24.0.0 con permiso específico; evidencia aislada abajo, no certificación del conjunto ni compatibilidad universal |
| CA-RG317 | A aislada no activa comandos públicos ni utiliza recursos personales o clientes reales | Autorización explícita del encargo, fixtures/spies, preservación de imports/dispatch operativos y snapshots de código/configuración/memoria ajenos |

Los tests usarán hogares temporales propios y datos ficticios. Deben negarse a
utilizar el HOME real como destino y sustituir cualquier runner antes de entrar
en adaptadores legacy. Ninguna prueba autoriza ejecutar clientes de IA reales.
La integración con RG-1 podrá probar el descriptor con MCP sintético acotado,
pero no presentarla como nueva prueba nativa o cierre de RG-2.

## Tareas por dependencias

| Tarea | Depende de | Resultado / archivos probables | Comprobación |
| --- | --- | --- | --- |
| RG3-0 | Ninguna para el borrador | Aprobar alcance aislado y resolver adopción del parser/engines; objetivo 24.x registrado | No empezar código sin permisos del encargo ni decisiones restantes de CA-RG316 |
| RG3-A1 | RG3-0 y permiso para A | Descriptor/plan/inspector y recolector en módulos aislados bajo src/ | Fixtures, identidad física, límites, ausencia de spawn y CA-RG317 |
| RG3-A2 | A1 y alcance de pruebas autorizado | Verificar preview/status con dobles y fixtures, sin sustituir rutas públicas | Contratos, opciones y códigos simulados; imports/dispatch actuales intactos |
| RG3-I | A revisada, RG-2 cerrado y autorización propia | Integrar preview/status en src/connect.js, src/status.js, src/cli.js | CA-RG301 y regresión; permiso de integración no concede aplicación personal |
| RG3-B1 | RG3-I revisada, RG-2 cerrado y permiso para B | Aplicador/migración de tabla propia, preservación y cleanup | Tests con config ficticia, pins, conflictos y carreras |
| RG3-B2 | B1 | Regresión y guías project-memory-connect.md, project-memory-status.md, uso.md | Tabla criterio/evidencia y comprobación de enlaces |
| RG3-C | A/B cerradas y permiso nuevo | Especificación de otros clientes, sin migrarlos por inercia | Documentación oficial de variantes y gates propios |

Archivos probables de pruebas: test/connect.test.js, test/status.test.js y nuevos
tests del descriptor/inspector/aplicador. La CLI se comprueba mediante runCli;
no asumir que existe test/cli.test.js ni cambiar test/task-cli.test.js sin relación.
No fijar cifras de pruebas futuras. El cierre registra comandos, resultados,
duración/plataforma y desviaciones realmente observadas.

## Evidencia de esta entrega documental

Esta sección conserva el alcance de la entrega documental anterior a A1a/A1b.
Estado de aquella entrega: especificación propuesta con objetivo Node 24.x aceptado; implementación
aislada A solicitable con permisos propios y decisiones restantes; integración,
aplicación y publicación condicionadas al cierre del piloto. La excepción de
secuencia está registrada, no implementada.
Solo se creó y luego actualizó este archivo con autorización documental. Se
inspeccionaron fuentes locales y Estado actual
mediante MCP, listando su carpeta antes de leer. No se modificó el manifiesto,
memoria, código, configuración, dependencias o Skills; no se ejecutaron pruebas,
staging, commit, push, clientes nativos ni consultas de cuentas.

La especificación aporta alcance, diseño, tareas y verificaciones previstas.
No acredita CA-RG301..CA-RG317, funcionamiento portable o migraciones realizadas.

## RG3-A1b — Adopción aislada del lector TOML (2026-10-13)

Autorización específica: crear src/memory-connection-toml.js y su test, fijar
las dos dependencias revisadas, cambiar engines y lock a ^24.0.0, ajustar la
aserción exacta de test/task-cli.test.js y actualizar este documento y uso.md.
Son siete rutas; no se modifican descriptor/plan A1a ni connect/status/CLI.
La reducción del rango anterior >=20 es explícita y afecta esta base local,
no una publicación histórica. La guía técnica explica el alcance de migración.

### Artefactos y reproducción

- toml-eslint-parser 1.0.3: licencia MIT incluida; SRI
  `sha512-A5F0cM6+mDleacLIEUkmfpkBbnHJFV1d2rprHU2MXNk7mlxHq2zGojA+SRvQD1RoMo9gqjZPWEaKG4v1BQ48lw==`.
- eslint-visitor-keys 5.0.1: Apache-2.0 incluida; SRI
  `sha512-tD40eHxA35h0PEIZNeIjkHoDR4YjjJp34biM0mDvplBe//mB+IHCqHDGV7pxF+7MklTvighcCPPZC7ynWyjdTA==`.
- Instalación local sin scripts, audit, fund ni configuración npm personal:
  registro público explícito, userconfig/globalconfig vacíos y cache temporal
  propio. El lock anterior conserva sin cambios sus 104 paquetes; se agregan
  únicamente los dos anteriores. No se ejecuta npm audit fix ni actualización
  global. El experimento temporal previo pasó 38 pruebas, no pruebas del Toolkit.
- La revisión del par no certifica las dependencias anteriores: observaciones
  de licencia/deprecación de RG-1 siguen abiertas. Tampoco garantiza ausencia
  de vulnerabilidades o disponibilidad futura de paquetes.

### Contrato implementado y límites

readMemoryConnectionToml(bytes, { mcpName }) acepta string UTF-8 válido, Buffer
o Uint8Array genuino; copia las entradas sin ejecutar hooks. No acepta rutas,
defaults, getters ni proxies. Analiza el documento completo con TOML 1.0.0,
sin getStaticTOMLValue ni conversión global. Localiza por clave resuelta exacta
una tabla estándar propia y permite únicamente command, args, cwd, enabled_tools
y enabled con sus tipos estrictos. No crea valores ausentes ni valida por sí
solo el tuple operativo: una observación incompleta no se admite como conexión.

Inline/dotted propios, arrays de tablas, subtablas, namespace MCP sellado/scalar,
campos desconocidos o valores sensibles reconocidos producen blocked. Errores
de bytes, UTF-8, BOM, opciones o sintaxis producen invalid con códigos fijos.
Son estados del módulo puro, no códigos de salida de una CLI. No se retornan
diagnósticos crudos, texto ajeno ni objetos parciales de un rechazo.

El límite de entrada es 1 MiB; cada string propio admite 4096 bytes, args 16
elementos, enabled_tools 256 y el reporte 64 KiB. Después del parseo se recorren
solo nodos semánticos: máximo 30000 y profundidad 64. Estos límites posteriores
no son un sandbox ni un tope estricto de CPU/memoria durante el parser.
El filtro sensible es heurístico, no una certificación de ausencia de secretos.

La huella es SHA-256 sobre los bytes exactos suministrados. Los rangos propios
son índices UTF-16 JavaScript, no offsets UTF-8 ni parches listos para aplicar.
El reporte copiado/congelado declara evidence=provided-bytes y distingue
byteSyntaxVerified de configurationSourceVerified/localReadVerified/
nativeReadVerified/runtimeVerified/authorizationGranted, que siguen false.
No prueba que los bytes provengan de un archivo real o de la configuración activa.

La API puede alimentar declaraciones de prueba al plan A1a; esto no verifica
identidades físicas ni activa sus candidatos. Al cerrar A1b, recolector, editor por posiciones,
preview/status públicos, cambios de roots nativos y aplicación siguen pendientes.

### Verificación local

Entorno realmente ejecutado: Node v24.14.1, darwin/arm64. Datos ficticios y
procesos sintéticos de los tests existentes; no clientes ni cuentas reales.

| Comprobación | Resultado observado |
| --- | --- |
| node --check individual: lector, su test y test/task-cli.test.js | Tres códigos 0 |
| node --test --test-reporter=tap --test-concurrency=1 test/memory-connection-toml.test.js | 150/150, 222.171833 ms |
| node --test --test-reporter=tap --test-concurrency=2 test/memory-connection-toml.test.js test/memory-connection-descriptor.test.js test/memory-connection-plan.test.js test/task-cli.test.js | 358/358, 2295.533 ms |
| node --test --test-reporter=tap --test-concurrency=2 | 3666/3666, 98215.421375 ms |

Todas las ejecuciones anteriores: código 0, cero fallos, omitidas, canceladas o
todo. Las cifras son pruebas locales, no evaluaciones de modelos ni lecturas
nativas. El experimento temporal de 38 pruebas es evidencia distinta.

El snapshot de inicio conserva los archivos anteriores del Toolkit excepto las
cinco rutas existentes autorizadas; solo se agregan el lector y su test. El
descriptor/plan A1a, RG-1, los entrypoints, la bóveda y la Skill quedan intactos.
HEAD e659337 y staging vacío se mantienen. Se revisan también diff, espacios,
enlaces locales y el lock sin actualizar su grafo anterior.

Observación de preservación: durante la regresión se detectó una huella diferente
en la configuración compartida de Codex respecto del snapshot inicial. No hay
un comando de esta entrega destinado a editarla y no se la sobrescribe ni se
acepta la huella nueva como pin operativo. Su origen no está determinado; por
ello no se acredita preservación global de esa configuración. Aclararlo antes
de cerrar la entrega o autorizar un commit. No afecta la observación ficticia
del lector ni cierra el piloto nativo.

No se ha autorizado staging, commit, push, publicación, consultas a cuentas
ni cambios en la bóveda/configuración/Skills reales. RG-2/CA-RG12 siguen abiertos.

## RG3-A1c — Recolección local acotada (2026-10-13)

Modo autónomo autorizado únicamente para src/memory-connection-files.js,
test/memory-connection-files.test.js, este documento y docs/guias/uso.md. El usuario
autoriza implementar y probar el recolector de configuración, no recolectar
Skills, admitir runtimes/dependencias ni conectar o aplicar el plan A1a.
El desarrollo y las pruebas usan hogares temporales ficticios propios.

### Contrato previo a la implementación

collectMemoryConnectionConfiguration recibe tres datos obligatorios y cerrados:
homeDirectory, configurationPath y mcpName. Ambas rutas son POSIX absolutas,
canónicas, sin controles, enlaces o componentes . y .., con máximo 4096
caracteres y 64 componentes. configurationPath debe ser exactamente
homeDirectory/.codex/config.toml. No se deduce HOME, cwd, PATH ni una ruta real;
no se permite otro archivo arbitrario bajo la raíz ni descubrir credenciales.

Se validan mediante lstat todos los componentes desde la raíz. Los ancestros
previos al hogar pueden pertenecer a root o al usuario, sin escritura de grupo
u otros ni bits especiales. La única excepción es un ancestro temporal de root
con modo exacto 1777 (sticky); nunca se admite dentro del hogar. El hogar y
.codex deben pertenecer al usuario, permitir su acceso y no ser escribibles
por grupo/otros ni tener bits especiales. El archivo debe ser regular, sin
symlink ni hardlink, del usuario y modo exacto 0600, incluidos bits especiales.
Estos son controles POSIX locales, no evidencia de ACL o sandbox del sistema.

Hogar inexistente o padre inseguro bloquean. .codex o config.toml inexistentes
se observan como ausencia solo tras repetir las comprobaciones de padres y
confirmar que el primer componente ausente sigue ausente. No se crean rutas.
Un archivo presente se abre una vez con O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
se comparan identidades del descriptor, nombre y padres antes de leer. La
lectura pide bloques de hasta 64 KiB y nunca más del tamaño inicial ni de 1 MiB,
sin byte centinela o consulta extra al EOF. Se admiten archivos vacíos.

Después de leer se revalidan descriptor, nombre y padres, y se cierra el handle
antes de entregar un informe válido. El cierre se intenta una vez; si falla,
se bloquea sin afirmar que el descriptor haya quedado cerrado. Crecimiento, truncado, sustitución, cambios de
modo/dueño o ausencia que deja de serlo bloquean sin reintento. Cambios normales
de mtime del directorio por hermanos no invalidan su identidad; sí la invalidan
dev/ino/uid/gid/mode. Los metadatos del archivo incluyen tamaño y mtime/ctime.
Las comprobaciones antes/después no son un openat atómico, bloqueo de terceros
ni defensa garantizada contra todas las carreras ABA o restauraciones invisibles.

Solo bytes observados bajo esos controles pasan al lector A1b. El informe distingue
archivo ausente de archivo presente sin la entrada solicitada. Invalid corresponde
a argumentos; blocked a lectura/ruta/carrera/límite/TOML rechazado. Nunca devuelve
bytes, valores ajenos, mensajes del sistema ni un server parcial tras un rechazo.
Se incluyen SHA-256 exacto y huella acotada de metadatos solo en observaciones
completas. Los informes son copiados/congelados y caben en 128 KiB.

verificationScope=configuration-only delimita la evidencia. Con IO nativo,
configurationPathVerified y configurationSourceVerified describen exclusivamente
esa observación, localReadVerified solo una lectura terminada. physicalPathsVerified,
runtimeVerified, nativeReadVerified y authorizationGranted globales siguen false.
Los dobles de IO son dependencias confiables de prueba, no una barrera de seguridad;
su informe se marca simulated-local-file y no acredita lectura local nativa.
Ausencia no constituye lectura de bytes ni permiso de crear/aplicar.

### Criterios y secuencia

| ID | Resultado exigido | Verificación prevista |
| --- | --- | --- |
| CA-A1C01 | Datos cerrados y explícitos; entrada inválida no hace IO | Proxies, getters, rutas relativas/ajenas/no canónicas y nombre inválido |
| CA-A1C02 | Solo lstat de padres y lectura del archivo exacto | Instrumentación de IO, sin readdir, HOME/cwd, red ni procesos |
| CA-A1C03 | Metadatos inseguros bloquean antes de leer | Symlinks de cada componente, hardlinks, tipos, dueños, modos y bits especiales |
| CA-A1C04 | Ausencia comprobada no crea rutas | Hogar ausente, .codex/archivo ausentes y carrera de aparición |
| CA-A1C05 | Lectura limitada, sin EOF extra | Cero, límite exacto de 1 MiB, exceso, short reads y conteo de pedidos |
| CA-A1C06 | Cambios observables bloquean y cierran | Sustitución al abrir/durante lectura, padres, truncado, crecimiento y permisos |
| CA-A1C07 | Errores se redactan y no hay retry | EACCES/ELOOP, fallos de stat/read/close, TOML/sensible y mensajes ficticios |
| CA-A1C08 | Evidencia local y simulada están separadas | Facts, hashes exactos y metadatos; ausencia sin falsa lectura |
| CA-A1C09 | Reporte inerte y acotado; datos ajenos excluidos | Congelación, límites y marcadores ajenos de prueba |
| CA-A1C10 | Código público, memoria, Skill y dependencias intactos | Snapshots, diff y regresión local |

Orden: registrar contrato; construir comprobación/lectura/revalidación; probar
cada criterio; revisar diff, evidencia y alcance. No cambiar reader/descriptor/
plan, manifest/policy ni adaptadores para acomodar el recolector. El diagnóstico
anterior confirmó los ajustes propios del MCP sin determinar el cambio global;
esa observación histórica sigue abierta y no se convierte en un pin operativo.

### Evidencia de A1c

Resultado de quality-gate: **Aprobado con observaciones** para esta base aislada,
no aprobación global de RG-3, admisión operativa ni cierre de RG-2. El recolector
implementado conserva la separación del contrato, sin cambiar los módulos A1a/A1b.

Entorno ejecutado: Node v24.14.1, darwin/arm64. Dos node --check individuales
(módulo y test) terminaron con código 0. Los comandos siguientes se ejecutaron
con datos ficticios, nunca configuraciones personales como entrada del recolector:

| Comando | Resultado observado |
| --- | --- |
| node --test --test-reporter=tap --test-concurrency=1 test/memory-connection-files.test.js | 105/105; 250.989875 ms |
| node --test --test-reporter=tap --test-concurrency=2 test/memory-connection-files.test.js test/memory-connection-toml.test.js test/memory-connection-descriptor.test.js test/memory-connection-plan.test.js test/task-cli.test.js | 463/463; 2410.998416 ms |
| node --test --test-reporter=tap --test-concurrency=2 | 3771/3771; 96423.495625 ms |

Todas con código 0, cero fallos, omitidas, canceladas o todo. Son pruebas locales,
no certificación de runtimes, cuentas, conexión de otros clientes o modelos.

| Criterio aislado | Evidencia ejecutada / inspección |
| --- | --- |
| CA-A1C01 | Datos inválidos, proxies/getters y rutas; contador de IO y hooks en cero |
| CA-A1C02 | Apertura de una ruta exacta, lstat solo de la cadena; guards de discovery, escritura, red y spawn |
| CA-A1C03 | Symlinks, enlaces múltiples, tipos especiales, dueños, modos y bits; cero opens ante rechazo previo |
| CA-A1C04 | Ausencia nativa/simulada, hogar ausente y carreras de aparición; cero creación por el módulo |
| CA-A1C05 | Archivos cero, 1 byte, 64 KiB y 1 MiB; exceso, short reads, pedidos/bytes contados y cero EOF extra |
| CA-A1C06 | Reemplazos al abrir y después de cerrar, cambios durante read, padres, crecimiento incluso en cero/tope y truncado |
| CA-A1C07 | Fallos de lstat/open/stat/read/close, EACCES no ausente, parser y sensibles; mensajes ficticios excluidos y máximo un open/close |
| CA-A1C08 | Facts nativos vs simulados, ausencia sin falsa lectura, SHA-256 sobre CRLF/Unicode y huella de metadatos |
| CA-A1C09 | Congelación recursiva, rechazo sin server/hash parcial, límite del reporte y marcadores ajenos excluidos |
| CA-A1C10 | Snapshot de 292 entradas previas, cuatro rutas autorizadas, dependencias/CLI/memoria/Skill/config intactas; diff y regresión |

La inspección final verifica espacios y enlaces locales. HEAD e659337 y staging
vacío se conservan. Solo se agregan el módulo y test y se actualizan las dos
guías autorizadas; no se modifica la bóveda tras consultar su mantenimiento.

Observaciones: la evidencia ejecutada es solo macOS/arm64 con esa versión de
Node, aunque la API admite los controles POSIX de darwin/linux. No se acreditan
ACL, Windows, otras plataformas/minors, carreras invisibles, openat atómico,
origen de cambios históricos del config compartido o ausencia universal de secretos.
La configuración compartida mantiene en esta etapa la huella del snapshot de
inicio; eso no determina la causa de la diferencia histórica documentada en A1b.
Los criterios globales de identidad completa y cambios de roots nativos siguen
pendientes. No se autorizan commit, push, publicación ni aplicación real.

## RG3-A1d — Inspector aislado de instalación de Skill (2026-10-13)

Modo autónomo autorizado para src/memory-connection-skill.js, su prueba
test/memory-connection-skill.test.js, este documento y docs/guias/uso.md. Solo fixtures
ficticios; no se toca la Skill instalada, memoria, configuración, dependencias,
CLI ni módulos anteriores. Runtime/dependencias quedan para un alcance posterior.

### Contrato previo a implementar

inspectMemoryConnectionSkill recibe un objeto cerrado con descriptor y
expectedSkillSha256 (64 caracteres hexadecimales minúsculos), ambos explícitos.
Se copian datos inertes, se reconstruye el descriptor A1a y se exige igualdad
antes de IO. La huella debe estar revisada antes de invocar el inspector: nunca
se adopta una huella nueva por haber leído el archivo. No se deduce HOME/cwd.

Solo se inspeccionan la cadena del destino home/.agents/skills/<nombre> y la
cadena del origen declarado vault/07-AGENTES/skills/<nombre>/SKILL.md. Límite:
4096 caracteres y 64 componentes por ruta derivada. No se enumeran directorios,
consultan referencias/perfiles ni siguen destinos ajenos. Las comprobaciones
POSIX de padres mantienen dueño root/usuario antes de cada raíz, excepción
sticky root 1777 solo antes de ella y padres propios del usuario sin escritura
de grupo/otros ni bits especiales. Ningún padre puede ser symlink.

El único enlace admitido es el destino final propio, del usuario, con nlink=1
y sin bits especiales, apuntando mediante texto absoluto exactamente al origen
declarado. Sus bits ordinarios de permiso no se toman como control de acceso
al destino. readlink solicita bytes y decodifica UTF-8 estricto, sin sustituir
bytes inválidos por caracteres de reemplazo; texto de más de 4096 caracteres
o representación de más de 16384 bytes bloquean. Un enlace relativo, ajeno o un destino regular/directorio ocupando
el lugar da conflict, sin seguirlo, leer contenido ajeno o imprimir su destino.
Metadatos/enlaces de padres inseguros dan blocked. Un enlace ajeno roto no se
sigue para averiguar su rotura: ya es conflict por su identidad distinta.

La fuente esperada debe existir como directorio seguro y SKILL.md regular del
usuario, modo exacto 0600 y un solo enlace. Si la fuente esperada falta, incluso
con el enlace propio exacto roto, se bloquea; no se transforma en permiso para
crear contenido. Ausencia de .agents/skills/destino se revalida y solo da absent
si la fuente y sus bytes revisados sí pudieron comprobarse. Hogar ausente bloquea.

Se abre SKILL.md una vez con O_RDONLY | O_NOFOLLOW | O_NONBLOCK y se leen
como máximo 128 KiB, con pedidos de hasta 64 KiB limitados al tamaño observado,
sin EOF extra. Se permiten bytes vacíos si su huella revisada corresponde:
esta API no valida formato, frontmatter, semántica ni utilidad de la Skill.
Tampoco interpreta o ejecuta sus instrucciones. No devuelve contenido.

Se revalidan descriptor/nombre/padres de fuente y metadata/texto del enlace
propio antes/después de leer y tras cerrar. Cambios detectables bloquean sin
reintento, reparación, creación o reemplazo. Cierre fallido bloquea sin acreditar
que el handle esté cerrado. Una diferencia de SHA-256 bloquea sin mostrar una
huella sustituta ni hashes o estados matched parciales.

Los resultados son invalid, blocked, conflict, absent o matched; resolvedSource
solo aparece como valor en matched y siempre es el origen ya declarado. En
absent/matched, sourceSha256 coincide con el pin y metadataSha256 vincula las
observaciones de ambas cadenas y del archivo/enlace; no es permiso de aplicar.
conflict publica solo motivos y evidencia acotada del destino, sin leer SKILL.md.
El reporte copiado/congelado no supera 128 KiB ni expone errores crudos.

verificationScope=skill-installation-only distingue IO nativo de simulated-local-skill.
targetObservationVerified/skillSourceVerified/localReadVerified se limitan a
esta observación; source ausente no se verifica por un enlace parecido. Siempre
siguen false physicalPathsVerified global, runtimeVerified, nativeReadVerified,
skillFormatVerified, skillLoadedVerified y authorizationGranted. Los dobles son
dependencias de prueba confiables, no un sandbox ni una autorización.

No se certifican ACL, atomicidad openat, carreras ABA invisibles o que un host
haya cargado la Skill. Un hash revisado prueba comparación de bytes, no su
seguridad semántica. La identidad global/admisión de Node/bin/manifiesto/
dependencias y el cierre nativo de RG-2 quedan pendientes.

### Criterios y tareas

| ID | Resultado verificable | Prueba prevista |
| --- | --- | --- |
| CA-A1D01 | Entrada/pin/descriptor válidos antes de IO | Campos cerrados, falsos descriptors, proxies/getters y pin inválido con cero IO |
| CA-A1D02 | No leer destino ajeno ni referencias | lstat/readlink solo de rutas exactas, conflicto sin open, guards sin discovery/red/escritura/spawn |
| CA-A1D03 | Solo se admite enlace propio exacto | Enlace absoluto, relativo, roto ajeno, archivo/directorio ocupante y permisos/owner/bits |
| CA-A1D04 | Fuente segura necesaria aun para absent | Fuente ausente/unsafe, symlinks, hardlinks, tipos y file modo exacto |
| CA-A1D05 | Ausencia revalidada no crea ni borra | Padres/destino faltantes y carreras de aparición |
| CA-A1D06 | Lectura/pin limitados y sin adopción automática | Cero/límite/exceso/partial reads, conteos y hash mismatch sin huella nueva |
| CA-A1D07 | Carreras y cierres fallidos bloquean | Mutaciones de archivo, padres y enlace antes/durante/después; máximo un open/close |
| CA-A1D08 | Facts y reportes no exageran ni filtran | IO nativo vs simulado, formatos/carga no probados, errores y marcadores ajenos excluidos |
| CA-A1D09 | Lectura solo sobre fixtures propios | Inventario de fuentes, destinos temporales y guards |
| CA-A1D10 | Cuatro rutas, preservación y regresión | Snapshot, diff, enlaces y pruebas locales |

Secuencia: contrato; inspector de destino; lector/pin de fuente; revalidación y
reporte; pruebas por criterio; regresión/evidencia. No extraer o reescribir los
helpers de A1c dentro de este permiso: los módulos anteriores quedan intactos.

### Evidencia de A1d

Quality-gate: **Aprobado con observaciones** para A1d aislada. No acredita
funcionamiento del host, carga de Skills, admisión de runtime, autorización para
aplicar ni cierre integral de RG-3/RG-2. Se usó el contrato anterior para limitar
el código y una revisión del flujo incorporó lectura estricta de bytes del enlace.

Entorno ejecutado: Node v24.14.1, darwin/arm64. node --check individual del
módulo y test: ambos código 0. Datos y destinos ficticios propios; no se ejecutó
el inspector sobre la Skill realmente instalada ni clientes de IA/cuentas.

| Comando | Resultado observado |
| --- | --- |
| node --test --test-reporter=tap --test-concurrency=1 test/memory-connection-skill.test.js | 122/122; 417.121375 ms |
| node --test --test-reporter=tap --test-concurrency=2 test/memory-connection-skill.test.js test/memory-connection-files.test.js test/memory-connection-toml.test.js test/memory-connection-descriptor.test.js test/memory-connection-plan.test.js test/task-cli.test.js | 585/585; 3915.601125 ms |
| node --test --test-reporter=tap --test-concurrency=2 | 3893/3893; 100388.990792 ms |

Todas las ejecuciones: código 0, cero fallos, omitidas, canceladas o todo.
La primera tanda anterior de 107 pruebas fue seguida de las nuevas regresiones;
las cifras de la tabla corresponden al estado final revisado del módulo/test.

| Criterio aislado | Evidencia ejecutada / inspección |
| --- | --- |
| CA-A1D01 | Entradas cerradas, pin/descriptor falseados y hooks/proxies; cero IO/hook ejecutado |
| CA-A1D02 | IO de rutas exactas, conflictos sin open o lectura de SKILL.md y guards de discovery/escritura/red/procesos |
| CA-A1D03 | Enlace absoluto válido; relativo/ajeno/roto ajeno/loop/ocupantes, owner/bits y bytes mal codificados rechazados |
| CA-A1D04 | Fuentes/hogares ausentes, origen propio roto, symlinks, hardlinks, tipos especiales, modos/owner/bits y directorio como SKILL.md |
| CA-A1D05 | Tres ausencias y aparición al revalidar; fuente o pin incorrectos no quedan ocultos por destino ausente |
| CA-A1D06 | Tamaños 0/1/64 KiB/128 KiB, exceso, short reads y conteos; mismatch sin hash sustituto |
| CA-A1D07 | Sustituciones de fuente/enlace/padres durante open/read y tras close, crecimiento/truncado/modos y fallos IO con cierre único |
| CA-A1D08 | Facts nativos/simulados y conflicto metadata-only, informes congelados, texto fuente/errores ajenos excluidos y formato/carga false |
| CA-A1D09 | Fixtures con raíz/identidad/uid/0700 verificadas al limpiar; sin Skill real como entrada ni referencias leídas |
| CA-A1D10 | Snapshot de 294 entradas previas, dos archivos nuevos y dos guías; diff/enlaces/espacios y regresión |

Regresión específica de UTF-8: un enlace ficticio con un byte 0xff devuelve una
cadena engañosa con U+FFFD mediante decodificación de reemplazo normal, igual a
una ruta esperada distinta. La prueba crea ese caso real en el fixture y confirma
que readlink con encoding:buffer y decode estricto lo bloquean antes de leer
SKILL.md. No se interpreta una cadena reemplazada como identidad física.

El snapshot final conserva módulos A1a/A1b/A1c, RG-1, adaptadores/entrypoints,
dependencias, memoria, configuración compartida y Skill instaladas respecto del
inicio de esta etapa. HEAD e659337 y staging vacío permanecen. Se consultó el
mantenimiento de la memoria; no se actualiza por este trabajo local sin commit.

Observaciones: solo se probó esa versión/plataforma; no se certifican Linux,
Windows, otros minors, ACL, carreras invisibles/ABA, openat atómico, formato o
seguridad semántica de la Skill, carga por un host o procedencia de los cambios
históricos del config. BytePinMatched no prueba que el pin fuera autorizado:
el llamador debe revisarlo antes y authorizationGranted sigue false. Sigue
pendiente definir/admitir runtime y dependencias, cerrar RG-2 y autorizar por
separado integración, escritura, commit, push o publicación.

## RG3-A1e — Huellas de cinco artefactos base (2026-10-13)

Modo autónomo autorizado para src/memory-connection-artifacts.js,
test/memory-connection-artifacts.test.js, este documento y docs/guias/uso.md.
Es evidencia preliminar de archivos explícitos, no admisión de runtime o del
árbol de dependencias instalado. No se ejecutan Node ni candidatos inspeccionados,
instalan paquetes, recorren node_modules o modifican módulos anteriores.

### Contrato previo a implementar

inspectMemoryConnectionArtifacts recibe descriptor y expectedHashes cerrados.
Las cinco claves obligatorias son nodeSha256, binSha256, manifestSha256,
packageJsonSha256 y packageLockSha256, cada una de 64 hexadecimales minúsculos
revisados previamente. Datos inertes, descriptor reconstruido idéntico al de
A1a y pins válidos son requisitos antes de IO. No se descubre HOME/cwd/PATH.

Las únicas rutas de contenido son nodePath, el bin propio del descriptor,
manifestPath, toolkitRoot/package.json y toolkitRoot/package-lock.json. El
manifiesto debe ser descendiente de vaultPath; las raíces toolkit/vault deben
ser disjuntas. Rutas derivadas: máximo 4096 caracteres y 64 componentes.
Duplicados o archivos que sean ancestros de otra ruta se rechazan antes de IO;
alias físicos entre archivos o entre las raíces propias bloquean al inspeccionar.

Se comprueban todos los padres y archivos de las cinco rutas antes de la primera
lectura. Ningún symlink/hardlink/archivo especial se admite. El ejecutable Node
debe ser regular, de root o del usuario, con lectura/ejecución del dueño y sin
escritura de grupo/otros ni bits especiales. Esta base rechaza Node vía symlink;
no elige un realpath oculto. Toolkit/manifiesto pertenecen al usuario; bin y
metadatos admiten modos exactos 0600/0644, manifiesto solo 0600. Los padres propios
no admiten escritura de grupo/otros ni bits especiales; el ancestro root 1777
solo se admite fuera de las raíces propias. No se evalúan ACL ni firma de código.

Límites: Node 256 MiB, bin/manifiesto/package.json 512 KiB cada uno, lock 2 MiB;
total 260 MiB. La suma máxima por rol es 259.5 MiB: el límite total es un control
adicional conservador, no un escenario de exceso independiente alcanzable con
esos cinco límites. Las lecturas usan un solo buffer de hasta 64 KiB reutilizado,
nunca una asignación del tamaño completo de Node ni un pedido fuera del tamaño
observado o byte extra para EOF. Los bytes confirmados se acumulan antes de
cualquier rechazo posterior y no se reinician ante errores.

Se abre cada archivo como máximo una vez con O_RDONLY | O_NOFOLLOW | O_NONBLOCK.
Se revalidan descriptor/nombre/padres antes de leer, después y tras cerrar. Se
revalida todo el lote antes de cada apertura y al finalizar; un cambio posterior
en un archivo ya leído invalida el resultado. El cierre se intenta una vez aun
al fallar; un fallo bloquea sin certificar que el handle esté cerrado. No hay
reintentos ni reparaciones. No se presentan estas comprobaciones como openat
atómico, aislamiento frente a carreras ABA invisibles o sandbox del sistema.

Todos los hashes deben coincidir: diferencias o cualquier fallo devuelven blocked
sin huellas sustitutas ni verificaciones parciales. invalid es para argumentos.
Solo matched entrega el mapa de cinco hashes y metadataSha256 del lote observado.
El reporte incluye el contador de bytes confirmados por read, no una auditoría
del sistema ante excepciones de IO, y se copia/congela con límite de 128 KiB.
No devuelve contenido, rutas de errores, mensajes crudos o metadatos ajenos.

verificationScope=base-artifacts-only distingue IO local y simulaciones. Matching
de bytes no prueba versión/arquitectura de Node, ejecución, contenido válido del
manifiesto, resolución de imports, árbol instalado de node_modules, licencias
o seguridad semántica. runtimeVerified, installedDependenciesVerified,
manifestSemanticsVerified, nativeReadVerified y authorizationGranted siguen false.
Los pins no se mezclan automáticamente con el plan A1a ni conceden aplicación.

### Criterios y secuencia

| ID | Resultado observable | Verificación prevista |
| --- | --- | --- |
| CA-A1E01 | Descriptor/pins/rutas válidos antes de IO | Campos cerrados, getters/proxies, falsos descriptors, overlaps y pins inválidos |
| CA-A1E02 | Cinco rutas y preflight completo | Unsafe en la última ruta con cero opens, instrumentación sin readdir/import/ejecución |
| CA-A1E03 | Dueños, permisos, tipos y alias seguros | Node root/usuario, permisos por rol, symlinks/hardlinks/tipos y alias físicos |
| CA-A1E04 | Hash streaming acotado | Cero, límite/exceso por rol, partial reads, conteos y una sola asignación <=64 KiB |
| CA-A1E05 | Pins exactos y resultado sin parciales | Mismatch por cada rol, sin huella nueva ni mapa parcialmente aprobado |
| CA-A1E06 | Carreras detectadas en todo el lote | Mutaciones al abrir/leer/cerrar y cambios posteriores en un rol ya leído |
| CA-A1E07 | Fallos se redactan y recursos no se reintentan | lstat/open/stat/read/close, contador persistente y máximo un open/close por rol |
| CA-A1E08 | Evidencia modesta e inerte | Facts nativos/simulados, congelación, ningún candidato ejecutado/interpretado |
| CA-A1E09 | Fixtures sin datos reales | Node falso, manifiestos/paquetes ficticios; configuración/memoria/Skills intactas |
| CA-A1E10 | Alcance, formato y regresión | Snapshot, cuatro rutas, diff, enlaces y suite local |

Orden: contrato; preflight/alias; lectura por rol y revalidación de lote;
pruebas/revisión; evidencia. No ampliar el permiso a una inspección semántica,
importación de candidatos o certificación de las 106 dependencias instaladas.

### Evidencia de A1e

Implementación y verificaciones locales del 2026-10-14, America/Bogota.
La autorización histórica del 2026-10-13 no se mueve a la fecha de ejecución.
Quality-gate: **Aprobado con observaciones para A1e aislada**, tras la regresión
completa en serie del mismo día. CA-A1E10 tiene ahora evidencia global positiva
con concurrency=1; antes de esta repetición su cierre estaba pendiente por
evidencia insuficiente. No se declara RG-3/RG-2 aprobadas ni resueltos los fallos
de las ejecuciones paralelas. La admisión operativa conserva sus puertas propias.

Se crearon el inspector y su prueba, y se ampliaron únicamente estas dos guías.
node --check individual sobre ambos archivos nuevos: código 0. Entorno probado:
Node 24.14.1, darwin/arm64; no certifica Linux, Windows u otros minors.

| Comprobación | Resultado real |
| --- | --- |
| node --test --test-reporter=tap --test-concurrency=1 test/memory-connection-artifacts.test.js | 119/119; 832.970375 ms; código 0 |
| Tanda de siete archivos, concurrency=2: artifacts, skill, files, toml, descriptor, plan y task-cli | 704/704; 3067.600166 ms; código 0 |
| Regresión completa, concurrency=2, intento 1 | 4012 casos: 4010 pasadas, 1 fallo, 1 cancelada; 325098.456833 ms; código 1 |
| Supervisor existente aislado, concurrency=1 | 78/78; 39552.456208 ms; código 0 |
| Regresión completa, concurrency=2, intento 2 | 4012 casos: 4010 pasadas, 0 fallos, 2 canceladas; 146715.140209 ms; código 1 |
| Store y supervisor existentes, concurrency=1, sin cambios | 158/158; 64386.681708 ms; código 0; diagnóstico, no regresión global |
| node --test --test-reporter=tap --test-concurrency=1, regresión completa | 4012/4012; cero fallos, canceladas, omitidas o todo; 190872.064 ms; código 0 |

Las dos tandas satisfactorias nuevas no tuvieron fallos, omitidas, canceladas o
todo. La primera ejecución específica detectó un error del test de ruta larga:
el descriptor A1a ya rechazaba la ruta antes de llamar al inspector. Se corrigió
la prueba, sin modificar A1a; la cifra 119 corresponde al estado final.

El primer intento global falló en C2-08: plazo incluye blocked-stdin y fuerza
terminación (observación indeterminate frente a timed-out) y canceló C2-08:
stdin cerrado antes de entrega cancela sin espera indefinida por plazo excedido.
El segundo canceló C2-04: fallo antes de publicación temp-created no cambia
ledger y C2-07/12: gracia fuera del plazo no reserva ni inicia. Los dos últimos
registraron aproximadamente 46 segundos frente a su timeout de 20 segundos.
Son casos de módulos anteriores conservados byte por byte; ninguno importa el
inspector nuevo. Esto orienta la investigación de tiempos/entorno, pero no prueba
la causa ni permite ignorar los resultados. No se ampliaron timeouts ni se
modificaron esos módulos. Una repetición aislada exitosa no sustituye una
regresión completa satisfactoria. La repetición serial de ambos módulos pasa
158/158; confirma esa ejecución, no una causa ambiental demostrada ni el cierre
de la suite global. La ejecución posterior de la suite completa en serie pasa
4012/4012, sin modificar código ni ampliar los plazos. Esta ejecución sí aporta
regresión global positiva. No demuestra una causa de los fallos paralelos ni
garantiza que concurrency=2 sea estable: esa observación permanece abierta.

| Criterio aislado | Evidencia ejecutada / inspección |
| --- | --- |
| CA-A1E01 | Datos/pins cerrados, hooks/proxies, descriptor alterado, overlaps y límites de rutas; cero IO en invalid |
| CA-A1E02 | Cinco opens exactos; todas las rutas preflight antes del primero; peligro en último rol bloquea con cero opens; flags readonly y guards |
| CA-A1E03 | Modos/owners por rol, symlinks/hardlinks/directorios/tipos especiales, alias de archivos/raíces y padres inseguros; sticky root solo fuera |
| CA-A1E04 | Tamaños 0/1/64 KiB/64 KiB+1/512 KiB nativos; los cinco límites simulados suman 259.5 MiB; un buffer de 64 KiB; short reads sin sentinel |
| CA-A1E05 | Un mismatch por cada rol elimina todo hash/metadata y conserva bytes confirmados, sin nueva huella de referencia |
| CA-A1E06 | Sustitución de identidad, modo, padres, growth/truncado durante lectura, tras close y rol anterior cambiado al cerrar el último |
| CA-A1E07 | Fallos lstat/open/stat/read/close redactados; cierre único cuando hubo handle; EOF prematuro conserva bytes; ningún reintento |
| CA-A1E08 | Reports copiados/congelados/acotados, provenance nativa/simulada y todos los facts semánticos/operativos false; bytes opacos no interpretados |
| CA-A1E09 | Node/JSON/paquetes ficticios en árboles propios; cleanup valida ruta, tipo, uid, modo e identidad; guards de red/procesos/discovery/escrituras |
| CA-A1E10 | Snapshot inicial de 296 entradas, dos nuevos archivos y dos guías; repetición serial sobre 298 entradas sin cambios; formato/enlaces/heurística de secretos sin hallazgos; regresión global serial 4012/4012 |

El snapshot de esta etapa conserva A1a/A1b/A1c/A1d, RG-1, adaptadores, dispatch
CLI, package.json/lock, memoria, configuración compartida y Skill instaladas.
HEAD e659337 y staging vacío permanecen. Se consultó el mantenimiento de memoria;
no se actualiza por este trabajo local sin commit ni permiso para editarla.

Los máximos de streaming y algunos cambios de metadatos se simulan con IO de
prueba confiable: no son evidencia de un Node real de 256 MiB inspeccionado ni
de ejecución. Los archivos de muestra no prueban versión, firma, arquitectura,
validez del manifiesto, imports, dependencias instaladas, licencias o seguridad
semántica. Tampoco se certifican ACL, atomicidad openat, duración máxima de IO,
carreras invisibles/ABA ni procedencia de la modificación histórica del config.
Los pins requieren revisión independiente; nunca conceden autorización.

La revisión local de A1e queda completa con la observación de inestabilidad
paralela pendiente de diagnóstico. Solo se actualiza esta evidencia tras la
repetición; las 298 entradas previas conservaron huellas, modos y dueños, y el
resto sigue intacto después del cierre documental. No se crea commit ni push.

Siguiente alcance propuesto: definir la admisión semántica de manifiesto,
runtime y dependencias, sin confundir huellas de archivos con compatibilidad.
Su especificación e implementación requieren permisos separados; no se construye
automáticamente aquí. Cierre de RG-2, integración, aplicación real, commit/push
y publicación conservan sus puertas y autorizaciones.

## RG3-A1f — Validación pura del manifiesto (2026-10-14)

Modo autónomo autorizado para src/memory-connection-manifest.js,
test/memory-connection-manifest.test.js, este documento y docs/guias/uso.md.
El contrato siguiente se registra antes de implementar. No modifica el esquema
genérico, doctor, política RG-1, inspectores anteriores, dependencias o CLI.

### Contrato y límites

validateMemoryConnectionManifest recibe exactamente descriptor, manifestBytes
y expectedManifestSha256. Descriptor reconstruido idéntico al de A1a y pin
de 64 hexadecimales minúsculos se comprueban antes de interpretar contenido.
Los campos de la envoltura deben ser datos propios enumerables, sin getters,
proxies, símbolos ni hooks. El descriptor se copia; no se congela el llamador.

manifestBytes puede ser string Unicode válido, Buffer o Uint8Array ordinario,
copiado con las utilidades endurecidas existentes. No se usan conversiones,
iteradores ni getters personalizados de bytes; no se admiten subclases, proxies,
buffers compartidos o vistas sobre ellos. Máximo 512 KiB de bytes UTF-8, no de
caracteres. El pin se compara sobre la copia exacta antes de parsear JSON;
un mismatch no interpreta contenido ni devuelve una huella nueva de referencia.

JSON exige objeto raíz, UTF-8 estricto, sin BOM, duplicados (incluso claves
escapadas equivalentes), claves peligrosas ni Unicode inválido. Se reutiliza el
parser estricto puro: profundidad máxima 64, 30000 nodos y 256 elementos por
array, antes de Ajv. Ese límite de arrays estrecha esta base, no el esquema
genérico. Una cadena vacía o solo espacios no es un manifiesto válido.

Solo se compila una copia privada del esquema propio
schemas/project-memory.schema.json, con Ajv existente, strict/ownProperties,
sin coerción, defaults, eliminación de claves, fetch o esquemas del llamador.
La carga estática de módulos/esquema propios pertenece al arranque del módulo
confiable; el evaluador no lee archivos o rutas del manifiesto. El campo $schema
del manifiesto es declarativo: no selecciona ni descarga otro esquema.

Se exige schemaVersion 1.0.0 y los valores de seguridad existentes: mcpAccess
read-only, sensitiveDataPolicy forbidden, writeRequiresExplicitAuthorization true,
allowCredentialsInMemory false. Se comprueba contenido sensible con la heurística
existente; no se presenta como detector universal de secretos.

Las rutas de source.repositoryPath y memory.vaultPath se resuelven léxicamente
desde el padre de identity.manifestPath, nunca cwd/HOME/realpath. Rutas absolutas
deben ser canónicas; se permiten rutas relativas con . o .. para llegar a la
identidad declarada, pero no controles, backslashes, rutas Windows, componentes
privados/credenciales o valores recortados/ambiguos. La ruta final segura debe
coincidir exactamente con sourcePath/vaultPath. El manifiesto es descendiente de
la bóveda; Toolkit/bóveda siguen disjuntos, como requiere A1e. Es igualdad de
declaraciones POSIX, no identidad física de directorios.

memory.mcpServerName debe coincidir con mcpName. Los ID de agents son únicos,
no solo los objetos completos: exactamente una declaración codex, enabled=true,
con skillName explícito igual al descriptor. No se inventan defaults. Otros
agentes pueden declararse según el esquema, pero no se admiten o activan aquí.
La automatización declarada, sus horarios, remotos, layouts y enlaces no se
ejecutan, visitan o inspeccionan por resultar válidos estructuralmente.

Estados: invalid para envoltura/descriptor/pin/entrada de bytes no admitidos;
blocked para límites, formato/JSON, pin distinto, esquema, contenido sensible
o contradicciones; validated solo para los bytes y reglas declaradas comprobados.
Errores usan códigos fijos, sin texto original, valores, rutas ajenas o errores
Ajv/parser. Solo validated devuelve manifestSha256 y descriptorSha256;
blocked/invalid eliminan toda huella y éxito parcial. Reporte propio copiado y
congelado, máximo 128 KiB.

evidence=provided-bytes y verificationScope=manifest-declarations-only. Solo
manifestSchemaValidated, manifestSecurityValidated y manifestDescriptorMatched
pueden ser true en validated. manifestSemanticsVerified operativo,
physicalPathsVerified, localReadVerified, nativeReadVerified, runtimeVerified,
installedDependenciesVerified y authorizationGranted siguen false. No se une
automáticamente este resultado al plan ni a A1e; un pin no concede permiso.

### Tareas y criterios

Orden: registrar contrato; validar envoltura/copia/pin; parser/esquema propio;
comparación de identidades/agentes; tests y guías; evidencia de cierre.

| ID | Resultado observable | Evidencia requerida |
| --- | --- | --- |
| CA-A1F01 | Argumentos inertes y copia/pin anteriores al parseo | Envoltura cerrada, descriptor falseado, pin/hook/proxy/tipos y bytes mutables |
| CA-A1F02 | Esquema/seguridad y JSON estrictos | Falta/extra/tipos/versiones, UTF-8/BOM/duplicados/claves peligrosas, $schema externo sin fetch |
| CA-A1F03 | Raíces/rutas/MCP coincidentes sin discovery | Absolutas/relativas, espacios/Unicode, límites/privadas/Windows, overlaps y nombres distintos |
| CA-A1F04 | Agentes sin ambigüedad | Codex ausente/duplicado/deshabilitado, Skill omitida/distinta y otros agentes sin admisión |
| CA-A1F05 | Reporte modesto, redactado y congelado | Facts falsos operativos, sin hashes sustitutos/contenido/diagnósticos ni mutación del llamador |
| CA-A1F06 | Evaluador sin efectos laterales | Guards de FS/red/procesos/cwd/HOME y módulos anteriores sin integración |
| CA-A1F07 | Límites previos al esquema con fixtures | Bytes exactos/exceso, profundidad/nodos/arrays y entradas sintéticas sin datos personales |
| CA-A1F08 | Cuatro rutas, formato y regresión | Snapshot, node --check, tanda específica/relacionada y suite serial; observación paralela preservada |

### Evidencia de A1f

Implementación y pruebas del 2026-10-14, America/Bogota. El validador y su prueba
son nuevos; solo se amplían este documento y docs/guias/uso.md. Se conserva el esquema
propio y los módulos anteriores, sin nueva dependencia o comando público.
Veredicto inicial: **Sin evidencia suficiente para cierre de CA-A1F08**. El módulo
aislado y la tanda relacionada pasan, pero dos ejecuciones seriales completas
fallaron en módulos anteriores. Con esa evidencia inicial A1f no se declaró
cerrada ni integrada. El veredicto actualizado tras la corrección autorizada de
tiempos AD figura al final; la validación sigue sin integración operativa.

node --check individual sobre los dos archivos nuevos: código 0. La importación
del módulo/esquema confiable también pasó. Entorno: Node 24.14.1, darwin/arm64;
no certifica otras plataformas, versiones o árbol de dependencias instalado.

| Comprobación | Resultado real |
| --- | --- |
| node --test --test-reporter=tap --test-concurrency=1 test/memory-connection-manifest.test.js | 113/113; 204.390666 ms; código 0 |
| Nueve archivos relacionados, concurrency=2: manifest/artifacts/skill/files/toml/descriptor/plan/memory-mcp-policy/task-cli | 861/861; 3566.626042 ms; código 0 |
| Regresión completa, concurrency=1, intento 1 | 4125 casos: 4123 pasadas, 2 fallos; cero omitidas/canceladas/todo; 807972.608375 ms; código 1 |
| Repetición por nombre de los dos casos fallidos, concurrency=1 | 2/2; 1744.765791 ms; código 0; diagnóstico, no regresión global |
| Regresión completa, concurrency=1, intento 2 | 4125 casos: 4115 pasadas, 10 fallos; cero omitidas/canceladas/todo; 215760.439416 ms; código 1 |
| test/client-auth-diagnostic.test.js completo aislado, concurrency=1 | 229 casos: 224 pasadas, 5 fallos; cero omitidas/canceladas/todo; 21741.30225 ms; código 1 |

La primera tanda específica tuvo 112/113: una aserción comparó un Buffer con
structuredClone, que produce un Uint8Array. Se corrigió solo la comparación del
test, sin cambiar el validador; la cifra 113 corresponde al estado final.

El intento global falló en S2 runtime handles parent-child (indeterminate frente
a timed-out; aproximadamente 17.4 segundos frente a un plazo declarado de
1.5 segundos) y apply CI unknown impide escritura (git-error frente a
incomplete-evidence; aproximadamente 100.9 segundos en el caso). Ambos son
módulos existentes y no importan A1f; la repetición aislada pasa sin cambios.
No se ampliaron sus tiempos, alteraron aserciones, ejecutaron clientes de IA
o consultaron CI real. Se conserva esta evidencia: orienta investigación,
pero no demuestra una causa ambiental ni reemplaza una suite completa limpia.

El segundo intento falló en diez casos previos de
test/client-auth-diagnostic.test.js: receta fija; transportes ficticios 1 y 14;
transportes inválidos 9 y 10; consumidores concurrentes del permiso; y cuatro
comprobaciones post-run (artifact, entry, revoke, cancel). Los resultados incluyen
timed-out frente a observation-complete/indeterminate y causas esperadas ausentes.
Ese test compila/ejecuta un programa C sintético, no un CLI real ni una consulta
de cuentas. Su configuración declara processTimeoutMs=800, graceMs=100 y
confirmationMs=120. Se inspeccionó ese contrato sin modificarlo; las duraciones
observadas no demuestran por sí solas el origen de la inestabilidad. Se conserva
la observación global aunque una repetición aislada pudiera pasar.

La ejecución aislada de ese módulo tampoco quedó limpia: fallaron los transportes
ficticios 1, 14, 15, 16 y 20 (timed-out frente a observation-complete). Esto
reproduce un impedimento fuera del evaluador A1f, pero no demuestra su causa.
No se sigue repitiendo indefinidamente ni se modifica el diagnóstico existente
dentro de este permiso de cuatro rutas. Su investigación/corrección requiere
un alcance propio; no se avanza a una admisión operativa sobre esta evidencia.

| Criterio | Evidencia ejecutada / inspección |
| --- | --- |
| CA-A1F01 | Envolturas/pins/descriptor/hooks/proxies cerrados; copia de bytes, vistas offset y campos mutables; getters/iteradores no invocados |
| CA-A1F02 | UTF-8/BOM/duplicados/claves peligrosas, esquema/versiones/tipos/campos/seguridad y ausencia de defaults/coerción; $schema declarativo |
| CA-A1F03 | Rutas absolutas/relativas/nested con espacios/Unicode; controles, URI/Windows/privadas/límites, nombres y raíces disjuntas |
| CA-A1F04 | Codex ausente/deshabilitado/duplicado, Skill omitida/distinta y otros ID duplicados; agentes extra solo declarados |
| CA-A1F05 | Reporte/hash/facts copiados y congelados; errores fijos sin contenido, valores, diagnósticos o huella sustituta |
| CA-A1F06 | Guards FS/red/procesos/cwd/HOME/env al evaluar; esquema propio precompilado, sin loader de esquemas indicado por el manifiesto ni integración CLI |
| CA-A1F07 | 512 KiB exactos/exceso, Unicode en bytes, profundidad 64/65, arrays 256/257 y nodos; fixtures sintéticos en memoria |
| CA-A1F08 | Inicialmente snapshot de 298 entradas, dos archivos nuevos y dos guías; formato/enlaces/heurística de secretos sin hallazgos; cierre posterior de regresión y snapshot de 300 entradas al final |

Los tests no leen ni editan una bóveda/configuración/Skill/Node reales como
entradas del validador. La carga de código/esquema propios al importar el módulo
no se presenta como IO inexistente en el arranque: los guards comprueban el
evaluador, después de esa carga confiable. Datos remotos, layouts, horarios y
texto del manifiesto no se siguen, ejecutan o interpretan como instrucciones.

El pin no demuestra aprobación ni procedencia; los bytes suministrados deben
proceder de una revisión separada. La heurística de contenido sensible y la
comparación lexical no certifican secretos, ACL, identidades físicas, estructura
real de la bóveda o compatibilidad de runtimes/dependencias. Ningún campo del
manifiesto cambia estos límites ni activa escritura/automatización/clientes.

Se consultó Mantenimiento de la memoria; no se modifica por este trabajo local
sin commit y fuera del permiso de escritura de las cuatro rutas. Los problemas
de ejecuciones paralelas de A1e siguen documentados, no se dan por resueltos por
esta etapa. RG-2, admisión de Node/dependencias, integración, aplicación real,
commit/push y publicación mantienen alcances y permisos separados.

### Corrección autorizada de tiempos AD posterior a A1f

El 2026-10-14 se autorizó un alcance separado de tres rutas:
test/client-auth-diagnostic.test.js,
diagnóstico AD, sección AD-11 y este documento.
No se modifican A1f, su prueba, el recolector AD, su parser/esquema/fixture C,
dependencias, configuración, otras pruebas, memoria ni clientes IA reales.

Se separan integración C ficticia (3000/5000/100/120 ms para proceso/total/gracia/
confirmación), validación de presupuestos (perfil original 800/2500/100/120 ms)
y fronteras exactas en memoria (100/20/20 ms). Las señales virtuales nunca se
transmiten al sistema operativo. El objetivo es quitar la dependencia del arranque
real de las aserciones temporales exactas, sin convertir indeterminate en éxito,
EPERM en ausencia de grupo o permitir más de un arranque por permiso.

Las mediciones y repeticiones anteriores apuntan a sensibilidad de tiempos, pero
no prueban una causa del sistema operativo. Se conservan íntegros los fallos
históricos de esta sección: no son ejecuciones del estado corregido ni quedan
reemplazados por una repetición selectiva.

| Comprobación del estado corregido | Resultado real |
| --- | --- |
| Sintaxis del archivo AD | node --check, código 0 |
| Tiempo virtual/perfiles/relaciones de presupuesto | 14/14; 380.085959 ms; código 0 |
| AD completo aislado, concurrency=1 | 238/238; 20267.654041 ms; código 0 |
| Receta y cinco transportes válidos, dos tandas limitadas | 6/6 ambas; 1304.253833 y 1268.546583 ms; código 0 |
| AD y los nueve archivos relacionados de A1f, concurrency=1 | 1099/1099; 23641.437541 ms; código 0 |
| Regresión completa del estado corregido, concurrency=1 | 4134/4134; 199383.695 ms; código 0 |

Entorno final: Node 24.14.1, darwin/arm64. Las tandas finales tienen cero fallos,
canceladas, omitidas o todo. Los 4134 casos son los 4125 anteriores más nueve
pruebas de tiempo AD; no se excluyen casos anteriores. Snapshot de 300 entradas:
solo las tres rutas de esta corrección difieren; ninguna alta/baja, staging y
HEAD intactos. El módulo A1f, su prueba, el resto del código, configuración,
memoria y Skill conservan sus huellas. diff --check y enlaces locales correctos;
heurística de patrones sensibles sin hallazgos, no garantía absoluta.

Quality-gate actualizado: **Aprobado con observaciones** para el cierre de
CA-A1F08 y la corrección CA-ADT01 a CA-ADT05. A1f queda verificada como
evaluador puro de declaraciones suministradas, no integrada ni admitida para
lecturas físicas o ejecución. Las observaciones temporales históricas siguen
abiertas como antecedentes: una suite limpia no prueba su causa ni garantiza
otras versiones, plataformas o cargas. No se modifican los tiempos de S2/apply
ni se dan por resueltos los problemas paralelos documentados en A1e.

No se cierra RG-2, AD-3 ni la admisión operativa por pruebas de fixtures. Se
consultó Mantenimiento de la memoria, sin cambios en la bóveda. Esta entrega no
incluye commit, push, cuentas, clientes reales ni cambios de configuración.

## RG3-A1g — Coherencia de declaraciones de paquete y lock (2026-10-15)

### Estado, permiso y problema

La redacción inicial se autorizó por separado. El 2026-10-15 el usuario aprobó
el contrato y autorizó implementación autónoma y pruebas aisladas únicamente en
src/memory-connection-package.js, test/memory-connection-package.test.js,
este documento y docs/guias/uso.md. No autoriza cambiar dependencias, integrar comandos,
consultar cuentas/clientes, editar configuración/memoria, commit o push.
Profundidad SDD: rigurosa; otro módulo podrá usar este resultado como evidencia,
pero nunca como autorización o admisión operativa.

A1e comprueba huellas de cinco archivos sin interpretar su contenido; A1f valida
declaraciones del manifiesto de memoria. Falta comprobar si package.json y la
raíz de package-lock.json describen el mismo paquete y dependencias directas.
Huellas iguales a las revisadas no demuestran esa coherencia. A1g propone un
evaluador puro de dos capturas explícitas, no un inspector de instalaciones.

Base local consultada el 2026-10-15: package.json y package-lock.json declaran
agent-toolkit 0.1.0, Node ^24.0.0 y las mismas cinco dependencias de producción;
el lock declara lockfileVersion=3 y packages[""]. Es una observación de las
fuentes locales, no una ejecución de A1g, una certificación de seguridad ni una
promesa de cinco dependencias para todos los proyectos futuros.

Referencia externa: [formato oficial de package-lock.json de npm, CLI v11](https://docs.npmjs.com/cli/v11/configuring-npm/package-lock-json/),
consultado el 2026-10-15. Describe packages como un mapa de ubicaciones y la
entrada vacía como raíz del proyecto. A1g selecciona deliberadamente un perfil
limitado de lock v3; no implementa la compatibilidad completa de npm ni cambia
de formato porque se publique una versión posterior de la herramienta.

### Contrato de la base aislada autorizada

API: validateMemoryConnectionPackage. Entrada cerrada con exactamente
descriptor, packageJsonBytes, packageLockBytes, expectedPackageJsonSha256 y
expectedPackageLockSha256. Descriptor reconstruido idéntico al de A1a, raíces
Toolkit/bóveda disjuntas y manifiesto descendiente de la bóveda como en A1e/A1f.
Los dos pins son 64 hexadecimales minúsculos revisados previamente. Ni un pin ni
un descriptor aportado por el llamador prueban aprobación, procedencia o lectura.

Primero validar envoltura y descriptor sin invocar getters, proxies, iteradores,
toJSON o conversiones. Capturar copias propias de string UTF-8, Buffer o
Uint8Array ordinarios; rechazar SharedArrayBuffer, subclases y vistas/tipos no
admitidos. Límites por archivo: package.json 512 KiB, lock 2 MiB; total 2.5 MiB.
Validar tamaños/capturas y ambos hashes antes de decodificar o parsear cualquiera
de los JSON. Un mismatch bloquea sin devolver la huella real ni éxito parcial.

JSON estricto mediante las utilidades propias revisadas, sin modificar su
implementación: UTF-8 válido, sin BOM, claves duplicadas o peligrosas, texto
sobrante ni pérdida de precisión numérica. Límites por documento: profundidad
64, 30000 nodos, arrays de hasta 256 elementos y presupuesto de metadatos del
copiador compartido de 2000000 bytes. Este último también puede bloquear un
documento que cumpla el límite de bytes del archivo: no se promete aceptar todos
los JSON de 2 MiB. No pasar el lock completo por copyMemoryConnectionData, cuyo
límite de 128 KiB corresponde a descriptores/reportes, no a estos dos archivos.

El perfil admitido exige objetos raíz y estas comprobaciones observables:

1. lockfileVersion es el número 3, sin coerción. packages es un objeto y contiene
   su entrada propia "", también objeto. Otros formatos se bloquean como perfil
   no admitido; no se reparan ni convierten automáticamente.
2. name y version son cadenas no vacías de hasta 256 unidades UTF-16, sin
   controles ni espacios externos, y coinciden literalmente entre el
   paquete, la cabecera del lock y packages[""]. No se infiere identidad a partir
   del nombre de una carpeta, cwd, HOME, URL o archivos instalados.
3. dependencies es un mapa de cadenas no vacías en ambos objetos raíz. Comparar
   conjuntos de nombres y especificadores exactos, independientemente del orden.
   Una dependencia añadida, omitida o con texto distinto bloquea. Un campo
   dependencies ausente representa mapa vacío y puede coincidir con un mapa
   vacío presente; null, arrays o valores no cadena bloquean.
   No recortar valores ni convertir ^8.17.1 y >=8.17.1 en supuestos equivalentes.
4. engines, cuando está presente, es objeto, nunca null/array/escalar. Su campo
   node, si existe en uno de los dos objetos raíz, debe existir como cadena no
   vacía de hasta 1024 unidades UTF-16, sin controles/espacios externos e idéntica
   en el otro. Si falta en ambos, queda no declarado, no compatible por defecto.
   No consultar process.version para admitir el Node
   descrito, ejecutar nodePath ni evaluar satisfacción de rangos de versiones.
5. El perfil se limita a dependencies de producción. devDependencies,
   optionalDependencies y peerDependencies deben faltar o ser mapas vacíos en
   ambos objetos raíz. workspaces, overrides, bundleDependencies y
   bundledDependencies deben estar ausentes; su presencia bloquea como perfil no
   admitido. Esta restricción es de la primera base, no un juicio sobre npm.

Los nombres de dependencias y especificadores son datos, nunca rutas a abrir.
Se limitan a 256 entradas, 256 unidades UTF-16 por nombre y 1024 por especificador;
rechazar nombres/valores vacíos, controles o espacios externos. No se valida
la gramática completa de npm ni se interpretan alias, protocolos, rangos,
scripts, bin, URLs, rutas de packages o campos $schema. Un valor file/git/URL
idéntico en ambos mapas sigue siendo solo texto coincidente, nunca una fuente
admitida o un permiso de lectura, descarga, importación o ejecución.

Los demás campos se conservan únicamente como datos inertes durante el parseo;
no participan en la comparación ni certifican contratos omitidos. Campos no
comparados del paquete y entradas transitivas del lock pueden diferir sin que
A1g lo detecte. Un fallo de contenido sensible detectado por la heurística
existente en cualquiera de los documentos bloquea sin exponer el contenido;
la heurística no garantiza detectar todo secreto posible.

### Resultado y límites de confianza

Reporte copiado, congelado y máximo 128 KiB, con schemaVersion=1.0.0,
state=consistent/blocked/invalid, reasons de códigos propios fijos,
descriptorSha256, packageJsonSha256, packageLockSha256 y facts.
No devolver contenido, nombres de dependencias, versiones, rutas, errores
originales, diferencias detalladas ni valores de campos ajenos.

invalid corresponde a envoltura/descriptor/pins/tipos de entrada inadmisibles;
blocked a límites, hash distinto, formato, contenido sensible, perfil no
admitido o contradicciones. Solo consistent devuelve los tres hashes; en los
otros estados son null y se eliminan verificaciones parciales. Los reportes de
error también respetan formato, congelación y presupuesto.

Catálogo propuesto, sin mensajes derivados de las entradas: MC_PACKAGE_INPUT
para invalid; MC_PACKAGE_LIMIT, MC_PACKAGE_PIN_MISMATCH, MC_PACKAGE_FORMAT,
MC_PACKAGE_SENSITIVE, MC_PACKAGE_PROFILE, MC_PACKAGE_IDENTITY,
MC_PACKAGE_DEPENDENCIES y MC_PACKAGE_ENGINES para rechazos esperados;
MC_PACKAGE_VALIDATION para cualquier excepción no prevista, siempre blocked;
MC_PACKAGE_CONSISTENT solo en éxito. reasons contiene un único código. Orden
de decisión: entrada/capturas, ambos pins, parseo de paquete y luego lock,
contenido sensible, perfil, identidad, dependencias y motor. Una rama fallida
no añade resultados de comprobaciones posteriores.

evidence=provided-bytes y verificationScope=package-root-declarations-only.
Solo packageIdentityMatched, directDependencyDeclarationsMatched y
engineDeclarationMatched pueden ser true en consistent; el último solo si
engines.node está declarado en ambos. Su ausencia conjunta no se representa
como verificación de motor. Todos esos facts son false fuera de consistent.

rangeSatisfactionVerified, dependencyGraphVerified, installedDependenciesVerified,
runtimeVersionVerified, runtimeCompatibilityVerified, runtimeVerified,
physicalPathsVerified, localReadVerified, nativeReadVerified y
authorizationGranted siguen false. executable/applied/wrote/sent/executed son
false y humanReviewRequired es true. Un lock cuya raíz coincida pero cuya
resolución transitiva o versión fijada no satisfaga un rango puede resultar
consistent: el reporte no afirma haber verificado esos aspectos.

No leer archivos ni recorrer node_modules, instalar paquetes, resolver imports,
invocar npm/Node candidatos, iniciar procesos, consultar red, cuentas o CI.
La carga confiable de módulos propios al importar el evaluador se distingue de
su evaluación de bytes; los guards comprobarán esta última. No unir el resultado
automáticamente con A1e, el plan, connect/status o una autorización de ejecución.

### Diseño, tareas y pruebas previstas

Alternativas consideradas: usar npm para decidir coherencia introduce procesos
y resolución fuera de alcance; validar todo el grafo/rangos requiere otra
especificación y evidencia. Se propone comparación literal de declaraciones
raíz con un resultado explícitamente limitado, reutilizando parser/hash/copia
propios sin nuevas dependencias. El nombre consistent queda restringido por
verificationScope; no se mostrará como instalación lista o runtime admitido.

| ID | Criterio de aceptación propuesto | Verificación prevista |
| --- | --- | --- |
| CA-A1G01 | Datos inertes, descriptor/pins/capturas válidos y ambos hashes antes del parseo | Getters/proxies/toJSON/subclases/shared buffers; pin incorrecto combinado con JSON roto; ninguna huella sustituta |
| CA-A1G02 | JSON y presupuestos cerrados sin ampliar utilidades anteriores | UTF-8/BOM/duplicados/claves peligrosas, profundidad/nodos/arrays/metadatos, límite exacto/exceso por archivo y bytes mutables |
| CA-A1G03 | Perfil v3 y triple identidad coincidentes | Versiones de lock ausentes/1/2/4/string, packages o raíz mal formados, name/version contradictorios |
| CA-A1G04 | Mismos mapas de dependencias raíz y motor declarado | Orden irrelevante; alta/baja/texto distinto; vacíos/ausentes/null; engines ausente en ambos o solo un lado; límites de nombres/valores |
| CA-A1G05 | Formas fuera del perfil bloqueadas y datos no ejecutados | Campos de alternativas raíz, URLs/file/git/$schema/scripts inertes y entradas transitivas sin lecturas o resolución |
| CA-A1G06 | Reporte redactado y evidencia modesta | Congelación/copia, hashes solo en consistent, error fijo; rangos no evaluados y facts operativos false incluso en éxito |
| CA-A1G07 | Evaluador aislado, sin efectos laterales ni integración | Guards de filesystem/red/procesos/loader/cwd/HOME; tests solo con entradas ficticias explícitas |
| CA-A1G08 | Alcance y cierre verificables | Snapshot, sintaxis, tanda propia/relacionada, regresión serial, formato/enlaces y tabla de evidencia real |

Secuencia propuesta: aprobar este contrato; autorizar implementación autónoma
acotada; cerrar entrada/pins/parser; comparar perfil/declaraciones; implementar
pruebas adversariales y guards; verificar y registrar evidencia. Ante un fallo
de alcance, compatibilidad o regresión no relacionado, documentarlo y detener
la ampliación, sin reparar módulos ajenos ni relajar pruebas por inercia.

Las cuatro rutas del encargo autorizado son src/memory-connection-package.js,
test/memory-connection-package.test.js, este documento y docs/guias/uso.md. Este permiso
no se extiende a etapas posteriores. No modificar
A1a-A1f, parser compartido, esquemas, dependencias, imports/dispatch públicos,
configuraciones, Skills o bóvedas. No habilitar RG3-I/B ni cerrar RG-2/AD-3.

Los criterios anteriores se registraron como pruebas futuras, no ejecutadas por
existir el documento. Su ejecución posterior se identifica al final. El resultado
histórico de 4134/4134 pertenece al cierre AD/A1f del 2026-10-14 y no incluye A1g.
La autorización posterior de implementación se obtuvo de forma separada del
permiso inicial de redacción.

### Verificación de esta entrega documental

El 2026-10-15 se añadió únicamente esta sección; el contenido anterior permanece
idéntico. Snapshot de 300 entradas: solo cambia este documento, sin altas/bajas,
HEAD e659337 y staging vacío conservados. Formato, enlaces locales y heurística
de patrones sensibles comprobados sin hallazgos; no es garantía de ausencia
absoluta de secretos. Se consultaron Estado actual y Mantenimiento de la memoria
por el MCP propio: no se actualiza la bóveda ni se amplía su permiso de escritura.

No se implementó A1g ni se ejecutaron pruebas funcionales, instalación, clientes
IA, consultas de cuenta, commit o push. Los criterios CA-A1G01 a CA-A1G08 siguen
pendientes; estas verificaciones documentales no los dan por cumplidos.

### Implementación y evidencia de A1g

Implementación autorizada el 2026-10-15, America/Bogota, en las cuatro rutas
enumeradas arriba. La sección documental previa conserva su estado histórico:
ahora existen el evaluador puro y su prueba; no se modifica el contrato genérico,
los módulos A1a-A1f, el parser compartido, las dependencias ni la CLI.

Se exporta validateMemoryConnectionPackage y el mapa congelado de límites
MEMORY_CONNECTION_PACKAGE_LIMITS. Los documentos grandes se copian/parsean con
sus límites propios, no con el presupuesto de descriptores de 128 KiB. La suma
máxima por rol coincide con 2.5 MiB; no hay un caso de exceso combinado distinto
alcanzable si ambos máximos individuales se respetan. Sí se comprueba la suma
exacta. Los campos de longitud excesiva y los mapas de más de 256 entradas
devuelven MC_PACKAGE_LIMIT; otros defectos de comparación usan el código de su
campo. Las capturas de string comprueban Unicode válido al copiar, antes de
parsear JSON; ambos hashes deben coincidir antes de interpretar los documentos.

| Comprobación ejecutada | Resultado real |
| --- | --- |
| node --check individual sobre módulo y prueba nuevos | Código 0 en ambos |
| node --test --test-reporter=tap --test-concurrency=1 test/memory-connection-package.test.js | 161/161; 359.484916 ms; código 0 |
| Diez archivos relacionados, concurrency=1: package/manifest/artifacts/skill/files/toml/descriptor/plan/memory-mcp-policy/task-cli | 1022/1022; 4631.657375 ms; código 0 |
| Regresión completa, node --test --test-reporter=tap --test-concurrency=1 | 4295/4295; 199825.1265 ms; código 0 |

Todas las tandas tienen cero fallos, canceladas, omitidas o todo. Entorno de la
regresión: Node 24.14.1, darwin/arm64. Los 4295 casos son los 4134 anteriores más
161 nuevos; no se excluyeron pruebas previas. La cifra histórica 4134 no se
presenta como una ejecución que incluya este módulo.

| Criterio | Evidencia del estado implementado |
| --- | --- |
| CA-A1G01 | Envoltura exacta, descriptor modificado/solapado, hooks/proxies revocados/subclases/shared backing y vistas offset; ambos pins antes de JSON roto |
| CA-A1G02 | UTF-8/BOM/duplicados/claves peligrosas/precisión; bytes exactos/exceso y UTF-8; profundidad 64/65, nodos 30000/30001, arrays 256/257 y metadatos 2000000/2000001 |
| CA-A1G03 | Lock v3 estricto, raíz packages[""], tipos/versiones no admitidos y contradicción en las tres identidades |
| CA-A1G04 | Orden independiente; adiciones/bajas/texto/tipos distintos, ausencia y mapa vacío; motor omitido/contradictorio/tipo; límites exactos de cadenas y entradas |
| CA-A1G05 | Alternativas raíz bloqueadas; URLs/file/git/$schema/scripts/bin y entradas transitivas tratadas como texto no seguido |
| CA-A1G06 | Informes congelados, hashes solo en éxito, facts de motor ausente false y hechos operativos siempre false; excepción inesperada redactada |
| CA-A1G07 | Guards FS/red/procesos/loader CommonJS/cwd/HOME durante evaluación y revisión de imports estáticos propios; datos solo ficticios, sin candidatos ejecutados |
| CA-A1G08 | Sintaxis, tanda propia/relacionada y regresión completa serial anteriores; snapshot de 300 entradas con solo dos guías modificadas y dos archivos nuevos; formato/enlaces/heurística sensible sin hallazgos |

Las pruebas no cargan ni usan como entrada los package.json/lock, Node,
configuración, bóveda o Skill reales del equipo. La ejecución del harness Node
confiable para pruebas no es la ejecución del nodePath candidato. Los guards se
instalan después de cargar módulos propios confiables; la inspección del código
confirma ausencia de import dinámico de rutas del llamador. No se certifica el
loader del sistema operativo ni la instalación por estos guards.

Los perfiles de desarrollo/opcionales/peers/workspaces quedan fuera de esta base,
no declarados defectuosos. consistent puede coexistir con una versión transitiva
incompatible o una ruta declarada inexistente: rango/grafo/instalación/runtime
siguen sin verificar. Licencias, deprecación, compatibilidad universal y permisos
operativos no quedan resueltos. RG-2, RG3-I/B, AD-3, commit/push y publicación
conservan sus puertas y autorizaciones independientes.

Quality-gate: **Aprobado con observaciones para A1g aislada**, con evidencia de
CA-A1G01 a CA-A1G08. La verificación corresponde a esta versión/plataforma, no a
otros runtimes, sistemas o cargas. No resuelve las observaciones paralelas de
A1e ni demuestra una causa de los fallos históricos de AD. El valor consistent
es deliberadamente limitado a las declaraciones comparadas, no compatibilidad
de dependencias ni admisión de una instalación.

El snapshot final conserva las 300 entradas previas salvo las dos guías
autorizadas; solo se añaden módulo y prueba de A1g. Los demás módulos/tests,
package.json/lock, configuración compartida, memoria y Skill instalada conservan
huellas, modos y dueños. HEAD e659337 y staging vacío permanecen. Se revisaron
el flujo/diff, formato y enlaces locales, con heurística sensible sin hallazgos,
no garantía absoluta de ausencia de secretos. Se consultó Mantenimiento de la
memoria: no se actualiza por este trabajo local sin permiso para editarla.
No se crean commit/push ni se ejecutan clientes IA, candidatos o instalaciones.

## RG3-A1h — Diagnóstico conjunto de declaraciones (2026-10-15)

### Estado, permiso y objetivo

Tras el permiso inicial de redacción, el 2026-10-15 el usuario aprobó el contrato
y autorizó implementación autónoma y pruebas en src/memory-connection-diagnostic.js,
test/memory-connection-diagnostic.test.js, este documento y docs/guias/uso.md. No se
autorizan integración pública, inspección personal, activación de conexiones,
dependencias nuevas, memoria, cuentas, clientes IA, commit o push.

Profundidad SDD: rigurosa. El objetivo es reunir las declaraciones de
configuración, Skill, artefactos, manifiesto y paquete en un informe único,
detectar contradicciones de descriptor/pins y conservar los pendientes.
No basta sumar cinco resultados positivos: pueden pertenecer a proyectos,
capturas o revisiones diferentes. Tampoco una coincidencia de huellas prueba
compatibilidad de Node, árbol instalado, procedencia o funcionamiento por MCP.

Base inspeccionada: A1c devuelve una observación de configuración; A1d, el
estado de instalación de Skill; A1e, cinco huellas; A1f y A1g, resultados puros
de bytes proporcionados. Los tres primeros no devuelven un descriptorSha256
común que autentique el lote. Ninguno de estos contratos demuestra un snapshot
atómico entre módulos. No se modifican esos módulos ni se les atribuye una
garantía nueva por combinarlos.

### Diseño de la base aislada

Se implementa un evaluador puro, summarizeMemoryConnectionEvidence, que recibe
proyecciones cerradas de resultados, con vinculaciones declaradas y pins
revisados. No invoca recolectores ni validadores anteriores, abre archivos o
reconstruye evidencias desde rutas. El llamador prepara las proyecciones; un
adaptador de recolección real no forma parte de A1h.

Un informe bruto de A1c-A1g no es una proyección válida: contiene campos que
este contrato no consume. No eliminar silenciosamente extras o facts del
llamador para aceptar ese informe. La futura integración deberá seleccionar
explícitamente los campos y explicar su procedencia, con su permiso propio.
Declarar bindingSha256 no acredita que el productor haya usado ese descriptor.

Alternativas: invocar los recolectores ahora introduciría IO, nueva revisión
de carreras y permisos no concedidos; aceptar cualquier informe con state
positivo permitiría mezclar evidencias; elevar los facts declarados a hechos
locales/nativos inventaría confianza. Se propone una capa de coherencia de
declaraciones, explícitamente no operativa, antes de diseñar esa integración.

### Entrada cerrada y límites

Envoltura con exactamente schemaVersion, descriptor, reviewedPins y components.
schemaVersion=1.0.0. Copia inerte sin getters/proxies/iteradores/toJSON, símbolos,
ciclos o prototipos no ordinarios, como en A1a. Reconstruir el descriptor idéntico
y aplicar las restricciones de raíces de A1e/A1f/A1g. No descubrir HOME/cwd/PATH.

reviewedPins contiene exactamente configurationSha256, skillSha256,
nodeSha256, binSha256, manifestSha256, packageJsonSha256 y packageLockSha256.
Todos son 64 hexadecimales minúsculos; solo configurationSha256 admite null,
que declara ausencia esperada de archivo. Los pins se revisan antes y no se
aprenden de las proyecciones. Su coincidencia no prueba autorización o fuente.

components contiene exactamente configuration, skill, artifacts, manifest y
package. Cada valor es null (sin informe suministrado) o un objeto de la tabla.
Todos los campos indicados son obligatorios, sin extras. bindingSha256 debe ser
un hash de 64 hexadecimales que declara el descriptor de esa proyección; se
compara con memoryConnectionHash(descriptor). No es un token ni firma.

| Componente | Campos exactos de la proyección, además de bindingSha256 | Estados admitidos |
| --- | --- | --- |
| configuration | state, mcpName, fileState, entryState, configurationSha256, metadataSha256, server | observed, absent, blocked, invalid |
| skill | state, skillName, sourceSha256, metadataSha256, resolvedSource | matched, absent, conflict, blocked, invalid |
| artifacts | state, hashes, metadataSha256 | matched, blocked, invalid |
| manifest | state, descriptorSha256, manifestSha256 | validated, blocked, invalid |
| package | state, descriptorSha256, packageJsonSha256, packageLockSha256 | consistent, blocked, invalid |

Límite total de entrada y de reporte: 128 KiB cada uno, incluidos descriptor y
las cinco proyecciones; no cinco veces 128 KiB. Usar límites compartidos de
copia: profundidad 64, 30000 nodos y arrays de 256 elementos. Solo metadatos JSON,
sin capturas de bytes, binarios, JSON textual o objetos ejecutables. Los campos
fuera de perfil/tipo invalidan la envoltura; no se convierten ni descartan.
Exceso de presupuesto se informa como blocked/MC_DIAGNOSTIC_LIMIT, no ausencia.
La excepción de clasificación para server observado se describe abajo: un
objeto inerte no reconocido es evidencia de conflicto, no una tabla reparable.

Nombres mcpName/skillName coinciden con el descriptor cuando hay observación
positiva; admiten null solo en estados blocked/invalid. Las rutas y strings de
server/resolvedSource se limitan a 4096 unidades UTF-16, sin controles ni espacios
externos. Ninguno se abre. Los metadatos opacos son hashes o null según las
variantes siguientes; no se aceptan hechos de lectura suministrados como facts.
La heurística sensible sobre la copia completa bloquea hallazgos sin devolver
su contenido; no garantiza detectar todo secreto.

### Variantes y comprobaciones cruzadas

1. En configuration.observed: fileState=present, configurationSha256 y
   metadataSha256 son hashes; entryState=observed/absent. Si entryState=absent,
   server=null. Si entryState=observed, server es objeto inerte; la forma segura
   reconocida contiene exactamente command, args, cwd, enabled_tools y enabled.
   command/cwd son strings, args hasta 16 strings, enabled_tools hasta 16 strings
   y enabled booleano. Una observación de tabla incompleta/desconocida es un
   conflicto de configuración, no una receta que completar con defaults.
   configurationSha256 debe coincidir con reviewedPins.configurationSha256;
   si se esperaba ausencia, un archivo observado contradice el pin y bloquea.
2. En configuration.absent: fileState=absent, entryState=null, server=null,
   configurationSha256=null y metadataSha256 hash. Exige pin de configuración
   null; se informa pendiente de configuración, no lectura de bytes realizada.
   En blocked/invalid: fileState=unknown, entryState/server/hashes null y
   mcpName null o el nombre propio; se informa impedimento, nunca ausencia.
3. Con entrada observada, comparar command, args en orden y cwd con el tuple
   protegido del descriptor; enabled_tools debe contener exactamente las nueve
   lecturas propias, sin duplicados, independientemente del orden. enabled se
   comprueba por separado: false significa deshabilitado/pendiente, no conflicto
   con el false del descriptor propuesto. No inferir enabled=true si falta.
   Legacy, argumentos extra, env u otro tuple se informan como conflicto; no se
   genera candidato ni se propone o aplica una migración en A1h.
4. skill.matched exige nombre propio, sourceSha256/metadataSha256 hashes y
   resolvedSource exactamente descriptor.skill.source. skill.absent conserva
   esos dos hashes, pero resolvedSource=null: fuente revisada, instalación
   pendiente. En ambos sourceSha256 debe coincidir con reviewedPins.skillSha256.
   conflict/blocked/invalid exigen sourceSha256, metadataSha256 y resolvedSource
   null. Un vínculo a fuente diferente es contradicción, no una Skill utilizable.
5. artifacts.matched exige hashes con exactamente las cinco claves de A1e:
   nodeSha256, binSha256, manifestSha256, packageJsonSha256 y packageLockSha256,
   todas coincidentes con reviewedPins; metadataSha256 es hash. Los estados
   blocked/invalid exigen hashes y metadataSha256 null, sin positivos parciales.
6. manifest.validated exige descriptorSha256 igual al descriptor común y
   manifestSha256 coincidente con el pin y, si está disponible, artifacts.hashes.
   package.consistent exige descriptorSha256 común y sus dos hashes coincidentes
   con reviewedPins y, cuando exista, artifacts.hashes. En blocked/invalid los
   hashes de esos componentes son null. Ningún state positivo reemplaza la
   comparación de hashes; un pin diferente bloquea sin publicar el valor real.

La comparación de bindingSha256 aplica también a estados negativos. Cambiarlo
para que coincida no autentica su origen. Los metadataSha256 no prueban un lote
de la misma época: A1h no vuelve a leer recursos, usa relojes para certificar
vigencia o detecta que algo cambió después de las capturas. No se inventa un
collector atómico ni un pin de runtime/dependencias operativo.

### Resultado y precedencia

Reporte cerrado con schemaVersion=1.0.0, state, components, reasons,
descriptorSha256, bundleHash y facts. components siempre ordenados como
configuration, skill, artifacts, manifest, package; cada elemento tiene solo
id, status y code propios. Los status son declared-matched, missing, disabled,
conflict, blocked o not-provided. No copiar contenido, server, rutas, nombres,
pins individuales, estados/facts originales o errores del llamador.

Estados globales: invalid por envoltura/descriptor/pins/proyecciones fuera del
contrato; blocked por contenido sensible, vínculos/pins contradictorios o un
componente conflict/blocked/invalid; incomplete por proyecciones null,
configuración/entrada/Skill ausentes o servidor deshabilitado; coherent solo
cuando las cinco proyecciones positivas son compatibles y el servidor se
declara habilitado. Precedencia: invalid, blocked, incomplete, coherent. Los
impedimentos no quedan ocultos detrás de un componente que falte.

En invalid, components=[]; también en fallos globales de límite, contenido
sensible o excepción no prevista. Los demás resultados contienen cinco elementos.
Los status positivos en un resultado parcial son solo declaraciones comparadas,
no hechos verificados ni permiso. reasons usa códigos propios fijos, únicos y
ordenados. Catálogo: MC_DIAGNOSTIC_INPUT para invalid; MC_DIAGNOSTIC_LIMIT,
MC_DIAGNOSTIC_SENSITIVE, MC_DIAGNOSTIC_BINDING y MC_DIAGNOSTIC_PINS para bloqueos
globales; MC_DIAGNOSTIC_CONFIGURATION, MC_DIAGNOSTIC_SKILL,
MC_DIAGNOSTIC_ARTIFACTS, MC_DIAGNOSTIC_MANIFEST y MC_DIAGNOSTIC_PACKAGE para
impedimentos por componente; MC_DIAGNOSTIC_MISSING o MC_DIAGNOSTIC_DISABLED
para incompletos; MC_DIAGNOSTIC_COHERENT solo en éxito. Un error no previsto
devuelve blocked/MC_DIAGNOSTIC_VALIDATION, sin mensaje original.

En components, declared-matched usa MC_DIAGNOSTIC_MATCH; missing/not-provided
usan MC_DIAGNOSTIC_MISSING y disabled usa MC_DIAGNOSTIC_DISABLED. Conflictos de
nombre/tuple/estado negativo usan el código propio del rol; binding o pin
contradictorios usan MC_DIAGNOSTIC_BINDING o MC_DIAGNOSTIC_PINS. Por componente,
la precedencia de causas es binding, pins, impedimento del rol, pendiente y
coincidencia; las formas inválidas se detectan antes de clasificar cualquier
componente. reasons agrega los códigos de impedimento/pendiente únicos, no los
MC_DIAGNOSTIC_MATCH. En coherent solo contiene MC_DIAGNOSTIC_COHERENT. No se
inventa una clasificación de componentes si el fallo global impidió calcularla.

Solo coherent publica descriptorSha256 y bundleHash; los demás estados los
mantienen null, sin huellas sustitutas ni aprobación parcial. bundleHash se
calcula canónicamente sobre la envoltura copiada completa y aceptada: cambiar
proyección, pin o metadato cambia su declaración fijada, no concede autoridad.
Los campos code de componentes se toman del mismo catálogo de causas propio,
nunca de strings de razones ajenas. Reporte copiado/congelado y acotado también
en errores; no congelar ni modificar objetos del llamador.

facts.evidence=declared-reports y verificationScope=cross-report-declarations-only.
Solo declarationsLinked es true en coherent. provenanceVerified,
snapshotAtomicVerified, freshnessVerified, physicalPathsVerified,
localReadVerified, nativeReadVerified, skillLoadedVerified, runtimeVerified,
runtimeVersionVerified, runtimeCompatibilityVerified, installedDependenciesVerified,
authorizationGranted, executable, applied, wrote, sent y executed siguen false;
humanReviewRequired=true. No ascender a estos facts aunque los informes de
origen se presenten como locales/nativos. Una proyección falsificada coherente
puede pasar: A1h comprueba sus declaraciones, no prueba su procedencia.

No llamar a createMemoryConnectionPlan, editarlo, emitir candidateServer,
planHash, tokens, receta ejecutable, autorización o un mensaje de listo para
usar. No conectar connect/status/CLI, instalar/activar MCP, invocar recolectores,
clientes o candidatos, consultar cuentas, ni realizar IO de recursos destino.

### Criterios, tareas y puertas de aprobación

| ID | Criterio propuesto | Verificación prevista |
| --- | --- | --- |
| CA-A1H01 | Entrada inerte/cerrada y límites antes de comparar | Getters/proxies/hooks/símbolos/ciclos, descriptor falso, pins y claves extra, presupuesto total y límites de copia |
| CA-A1H02 | Cinco variantes estrictas sin defaults o éxitos parciales | Matriz de estados/tipos/hash/null/nombre, informe bruto rechazado y server incompleto/desconocido como conflicto |
| CA-A1H03 | Descriptor y pins del lote declarados coincidentes | Mezclar proyectos, binding distinto en cada rol y hashes distintos; manifiesto/paquete contra artefactos/pins comunes |
| CA-A1H04 | Tuple protegido y política exactos | Command/args/cwd/tools alterados, duplicados/extra, legacy, enabled ausente/false; cero candidato/migración |
| CA-A1H05 | Precedencia y parcialidad inequívocas | Coherent, cada ausencia/deshabilitado, múltiples pendientes y errores que dominan; orden estable de componentes/códigos |
| CA-A1H06 | Reporte redactado, congelado y sin confianza inventada | Hashes solo en coherent, pin canónico sensible a cambios, entradas mutables y facts de origen/tiempo/runtime siempre false |
| CA-A1H07 | Función pura sin activación ni IO | Guards filesystem/red/procesos/loader/cwd/HOME; imports/dispatch/colectores/plan anteriores intactos; solo datos ficticios |
| CA-A1H08 | Evidencia y alcance comprobados | Snapshot, sintaxis, tanda propia/relacionada, regresión serial, formato/enlaces, revisión y resultados fechados |

Secuencia aplicada: aprobar contrato y autorizar el encargo delimitado;
cerrar copia/perfiles; comparar bindings/pins/tuple; normalizar estados y reporte;
probar matrices/guards/regresión y registrar evidencia. Los resultados de la
implementación aislada figuran abajo; no son una conexión pública disponible
en el producto o una instalación personal admitida.

Rutas del encargo autorizado: src/memory-connection-diagnostic.js,
test/memory-connection-diagnostic.test.js, este documento y docs/guias/uso.md. No se
amplía el alcance a A1a-A1g, parser/esquemas/dependencias,
recolectores, plan, comandos públicos, memoria, configuración o Skills.

RG-2/CA-RG12, admisión de runtime y árbol instalado, RG3-I/B, conexiones reales,
commit/push y publicación conservan puertas y autorizaciones independientes.
Este diagnóstico no resuelve la prueba nativa de cambios de roots ni la sustituye
por sumar informes. Las 4295/4295 pruebas de A1g son evidencia histórica del
2026-10-15; no prueban A1h. Su evidencia posterior se identifica al final.

### Verificación de esta entrega documental

El 2026-10-15 se añadió únicamente A1h. Snapshot de 302 entradas: solo cambia
este documento, sin altas/bajas; el contenido anterior se conserva idéntico.
HEAD e659337 y staging vacío permanecen. Código, pruebas, dependencias,
configuración compartida, bóveda y Skill instalada conservan sus huellas.
diff --check y enlaces locales correctos; heurística de patrones sensibles
sin hallazgos, no garantía absoluta de ausencia de secretos.

Se consultaron Estado actual y Mantenimiento de la memoria mediante el MCP
propio. No se modifica la bóveda por este trabajo local ni se amplía el permiso
de escritura. No se implementó A1h, ejecutaron pruebas funcionales, clientes IA
o candidatos, consultaron cuentas, instalaron dependencias ni crearon commit/push.
Los ocho criterios CA-A1H01 a CA-A1H08 siguen propuestos y sin evidencia de
implementación; la comprobación documental no los declara cumplidos.

### Implementación y evidencia de A1h

El 2026-10-15, America/Bogota, se implementaron el núcleo puro y su prueba en
las cuatro rutas autorizadas. La verificación documental anterior es histórica,
no una afirmación de que aún falte este código. Se amplía docs/guias/uso.md sin nueva
dependencia, comando público o integración con plan/recolectores/validadores.

Se exportan summarizeMemoryConnectionEvidence y el mapa congelado
MEMORY_CONNECTION_DIAGNOSTIC_LIMITS. La copia usa las utilidades propias sin
modificarlas; sus presupuestos se conservan antes de clasificar componentes.
Límites generales de copia/bytes dan blocked/MC_DIAGNOSTIC_LIMIT. En campos
server/resolvedSource, longitud mayor que 4096, controles, espacios externos o
Unicode no representable son un perfil inválido: MC_DIAGNOSTIC_INPUT. La forma
incompleta/desconocida de un server inerte admitido sigue siendo conflicto, no
una tabla rellenada con valores implícitos.

Los nombres nulos solo se admiten en blocked/invalid; si se aporta un nombre en
esos estados debe ser el propio. Todas las variantes se validan antes de
clasificar: un impedimento no oculta una proyección mal formada posterior.
Comparar cada componente con los pins comunes impide que dos informes positivos
con huellas distintas se acepten juntos, incluso sin comparar pares a ciegas.
No hay garantía de procedencia: bindingSha256 sigue siendo una declaración.

| Comprobación ejecutada | Resultado real |
| --- | --- |
| node --check individual sobre módulo y prueba nuevos | Código 0 en ambos |
| node --test --test-reporter=tap --test-concurrency=1 test/memory-connection-diagnostic.test.js | 139/139; 216.911458 ms; código 0 |
| Once archivos relacionados, concurrency=1: diagnostic/package/manifest/artifacts/skill/files/toml/descriptor/plan/memory-mcp-policy/task-cli | 1161/1161; 4782.660125 ms; código 0 |
| Regresión completa serial, intento 1 | 4434 casos: 4431 pasadas, cero fallos, 3 canceladas, cero omitidas/todo; 1232879.599875 ms; código 1 |
| Diagnóstico por nombre de los tres casos cancelados, sin cambios, concurrency=1 | 3/3; 3473.174042 ms; código 0; no sustituye una regresión global |
| Regresión completa serial, intento 2, sin cambios de módulo/test | 4434/4434; cero fallos, canceladas, omitidas o todo; 198560.499709 ms; código 0 |

Las tandas propia y relacionada tienen cero fallos, canceladas, omitidas o todo.
La primera tanda propia también pasó 134/134, 207.3235 ms; la revisión añadió
cinco casos de mezcla de proyectos y amplió la comprobación de binding en
informes negativos. La cifra 139 corresponde al estado final de módulo/test.
La primera regresión completa canceló tres casos del supervisor previo. Se
realizó la única repetición serial completa prevista, con módulo/test iguales y
sin modificar el supervisor ni sus plazos: pasó 4434/4434. Esa ejecución aporta
regresión global positiva para CA-A1H08, no una causa probada de las cancelaciones.
Los resultados de la primera ejecución se conservan íntegros.

Los casos cancelados son C2-07/12: cliente real no reserva ni inicia;
C2-08/09: cancela o rechaza duplicate-json; y C2-10: parent-child, no confunde
exit del padre con cierre del grupo. El timeout configurado de esos tests es
20000 ms; registraron 212794.981917, 353983.830625 y 456090.349083 ms. El primero
comprueba precisamente que un identificador de cliente nativo no arranque;
los otros ejecutan fixtures del supervisor, no clientes IA ni modelos reales.
El supervisor y su test conservan sus huellas y no importan A1h. No se ha
demostrado una causa de las demoras, suspensión del host u otro problema del
entorno; la repetición aislada satisfactoria no demuestra ninguna de ellas.

| Criterio | Evidencia de la implementación aislada |
| --- | --- |
| CA-A1H01 | Copia sin hooks/proxies revocados/bytes/símbolos/ciclos, descriptor alterado/raíces, siete pins cerrados; bytes exactos/exceso, profundidad 64/65, nodos 30000/30001, arrays 256/257 |
| CA-A1H02 | Proyección cerrada por rol, hashes/null y estados positivos/negativos; faltas/extras/facts y salida bruta rechazados; tabla parcial clasificada como conflicto |
| CA-A1H03 | Mezcla de cada rol entre dos descriptores, binding también en negativos, descriptor interno de manifest/package y siete pins contradichos; cero hashes de reemplazo |
| CA-A1H04 | Command/args/cwd/tools, tipos, omisiones, duplicados/extras/legacy y enabled; nueve lecturas exactas, sin candidato/plan ni migración |
| CA-A1H05 | Cinco ausencias, configuración/Skill faltante, disabled, errores sobre pendientes y prioridad binding/pins/rol; orden fijo y códigos agregados únicos |
| CA-A1H06 | Reporte/arrays/facts congelados, entradas mutables intactas, pin canónico independiente del orden de claves y sensible a metadatos/tools; facts nativos/tiempo/procedencia siempre false |
| CA-A1H07 | Guards FS/red/procesos/loader CommonJS/cwd/HOME durante evaluación; revisión de imports propios, sin import dinámico/candidato ni llamadas a recolectores o plan |
| CA-A1H08 | Sintaxis y tandas anteriores; regresión serial final 4434/4434 con intento previo conservado; snapshot de 302 entradas y cuatro rutas exactas; formato/enlaces/heurística sensible sin hallazgos |

Los guards se instalan después de cargar módulos propios confiables. El harness
Node usado en pruebas no es un candidato descrito ejecutado por el diagnóstico.
Los inputs son datos ficticios en memoria, sin configuraciones/Skill/bóvedas
personales o resultados de una cuenta real. No se afirma una auditoría de todos
los loaders por interceptar las rutas CommonJS y revisar los imports estáticos.

coherent solo significa compatibilidad de las declaraciones comparadas: no es
permiso, snapshot atómico, vigencia o certificación de que los informes procedan
del mismo sistema. RG-2, admisión de runtime/árbol instalado, integración pública,
activación, memoria, commit/push y publicación conservan sus puertas propias.

Quality-gate: **Aprobado con observaciones para A1h aislada**, con evidencia de
CA-A1H01 a CA-A1H08. La regresión final se ejecutó en Node 24.14.1, darwin/arm64;
los 4434 casos son los 4295 previos más 139 de A1h. No se suprimieron casos,
ampliaron plazos o modificaron aserciones del supervisor para obtener ese cierre.
Las cancelaciones temporales anteriores siguen como observación pendiente de
causa; no se certifica estabilidad universal ni se dan por resueltos los fallos
paralelos documentados en A1e. Las pruebas solo acreditan el alcance descrito.

Snapshot final de 302 entradas previas: únicamente difieren las dos guías
autorizadas y solo se añaden el módulo y test de A1h. El resto del código,
pruebas, dependencias, configuración compartida, bóveda y Skill conservan sus
huellas, modos y dueños. HEAD e659337 y staging vacío permanecen. La revisión
de flujo/diff, diff --check, formato y enlaces locales pasa; heurística sensible
sin hallazgos, no garantía absoluta. Se consultó Mantenimiento de la memoria,
sin editarla por este trabajo local fuera de su permiso de escritura.
No se ejecutan clientes IA, candidatos, instalaciones, commit o push.

## RG3-A2a — Recorrido conjunto con proyecto ficticio

Contrato aprobado y ejecución autorizada el 2026-10-15, America/Bogota.
Esta etapa prueba descriptor → configuración/Skill/artefactos → declaraciones
de manifiesto/paquete → diagnóstico. Es un subconjunto de RG3-A2: no incorpora
preview/status, comandos públicos o migración. RG-2/CA-RG12 y RG3-I/B siguen
pendientes de su evidencia y autorización independientes.

Únicas rutas de este lote: test/memory-connection-flow.test.js, este documento
y docs/guias/uso.md. No se modifican módulos funcionales, pruebas previas, dependencias,
configuración personal, Skills instaladas, bóvedas, commits o remotos. Una
incompatibilidad entre contratos se informa, sin corregir módulos fuera del lote.

La prueba crea una raíz temporal propia validada, con home, código, Toolkit,
bóveda, configuración y Skill ficticios. Node y bin son archivos inertes: nunca
se ejecutan. Los siete pins se calculan sobre los bytes de fixture previstos
antes de escribirlos o inspeccionarlos, nunca se adoptan del resultado observado.
Los validadores puros reciben esos bytes previstos, enlazados mediante los pins
con los archivos inspeccionados; no se afirma una captura atómica del filesystem.

Un adaptador explícito, local al test, selecciona las cinco proyecciones cerradas
de A1h. No es una API pública ni un mecanismo de autenticación de informes.
La evidencia final continúa siendo declared-reports: procedencia, vigencia,
snapshot atómico, lectura nativa, Skill cargada, runtime, árbol instalado y
autorización permanecen sin verificar, incluso en el caso coherent.

| Criterio | Comprobación prevista |
| --- | --- |
| CA-A2A01 | Recorrido válido usando los módulos reales y archivos ficticios, sin rellenar campos ni sustituir informes positivos |
| CA-A2A02 | Configuración ausente, entrada propia ausente, servidor deshabilitado y enlace de Skill ausente quedan incomplete |
| CA-A2A03 | Pins incorrectos y manifiesto/paquete contradictorios bloquean; una ausencia no oculta un impedimento |
| CA-A2A04 | Informes de dos fixtures distintos no se mezclan; binding declarado sigue sin autenticar origen |
| CA-A2A05 | Inspección solo de rutas previstas, sin escrituras durante el recorrido, procesos/red/candidatos ni cambios de HOME/cwd |
| CA-A2A06 | Reporte congelado/redactado y sin hechos operativos inventados; fixtures preservados y limpieza de raíz exacta validada |
| CA-A2A07 | Sintaxis, tanda propia/relacionada, regresión serial y revisión del alcance con resultados reales |

Al registrar este contrato los siete criterios están pendientes de ejecución.
La evidencia de cierre se añade abajo, conservando separadas intención y prueba.

### Implementación y evidencia de RG3-A2a

El 2026-10-15 se creó únicamente el test previsto y se ampliaron las dos guías
autorizadas. Se usaron los siete módulos reales del recorrido, sin cambiar sus
interfaces o implementación. No se encontró una incompatibilidad que requiriera
ampliar el encargo. Los fixtures contienen solo datos inventados, incluso Node
y bin; el harness confiable de pruebas es distinto de esos archivos candidatos.

El adaptador test-only selecciona cada campo admitido de los cinco informes;
no hereda facts, razones o campos extra. bindingSha256 lo declara ese adaptador,
no el inspector: su coincidencia no prueba el origen. Los validadores reciben
los bytes previstos, no bytes extraídos de los reportes ni una lectura simultánea.
Un caso altera el manifiesto en disco después de fijar pins: el validador puro
todavía valida los bytes previstos, pero artefactos y diagnóstico bloquean.
Así se comprueba esa separación sin convertir datos esperados en estado vigente.

| Comprobación ejecutada | Resultado real |
| --- | --- |
| node --check test/memory-connection-flow.test.js | Código 0 |
| Test nuevo, reporter=tap y concurrency=1 | 28/28; 658.158375 ms; código 0 |
| Doce archivos relacionados: flow/diagnostic/package/manifest/artifacts/skill/files/toml/descriptor/plan/memory-mcp-policy/task-cli, concurrency=1 | 1189/1189; 5397.28075 ms; código 0 |
| Regresión completa, reporter=tap y concurrency=1 | 4462/4462; 199760.179958 ms; código 0 |

Todas estas tandas finalizaron sin fallos, canceladas, omitidas o todo. La
regresión completa se ejecutó una vez en Node 24.14.1, darwin/arm64; suma las
4434 pruebas previas y 28 nuevas. No se cambiaron pruebas anteriores, plazos
o dependencias. Este resultado no explica ni elimina las cancelaciones
históricas del supervisor documentadas en A1h ni certifica estabilidad universal.

| Criterio | Evidencia observada |
| --- | --- |
| CA-A2A01 | Colector de configuración, inspectores de Skill/artefactos y validadores reales; estados observed/matched/matched/validated/consistent; repetición idéntica y pins previstos coincidentes |
| CA-A2A02 | Cuatro casos independientes, sin reparación: archivo ausente, entrada ausente, disabled y enlace de Skill ausente; fuente de Skill todavía contrastada cuando falta el enlace |
| CA-A2A03 | Siete pins incorrectos; tres archivos alterados tras fijarlos; tuple parcial, enlace ajeno, fuente ausente, manifiesto inseguro/malformado y paquete contradictorio; manifiesto bloqueado domina configuración ausente |
| CA-A2A04 | Cinco casos, cada uno mezcla un rol de dos fixtures reales distintos preservando su binding extranjero; todos bloquean, sin relabel ni confianza de origen |
| CA-A2A05 | Guards sobre operaciones comunes FS/red/procesos/fetch/chdir, cero llamadas prohibidas; lstat limitado a rutas y ancestros previstos, readlink al enlace propio, siete aperturas exactas en el caso válido, readonly/nofollow/nonblock y cierres correspondientes |
| CA-A2A06 | Snapshot recursivo antes/después de cada recorrido: bytes, enlaces, inventario, identidad, modos/dueños/tamaños y mtime/ctime intactos; HOME/cwd iguales; limpieza exacta validada; reporte congelado/redactado y hechos operativos false |
| CA-A2A07 | Sintaxis, tandas anteriores, snapshot de alcance de 304 entradas previas, formato/enlaces y revisión del flujo; ninguna edición de módulos funcionales |

Los guards se instalan después de importar los módulos confiables y se restauran
antes de comprobar/limpiar el fixture. No son un sandbox general ni interceptan
todas las posibles APIs del sistema. Las lecturas locales comprobadas pertenecen
al fixture; no equivalen a lectura nativa desde una app o una IA. El reporte
conjunto sigue siendo declared-reports, sin procedencia, vigencia o atomicidad
verificadas. El test también rechaza pasar informes brutos sin la proyección.

Quality-gate: **Aprobado con observaciones para RG3-A2a aislada**. Se verifican
CA-A2A01 a CA-A2A07 en el alcance descrito; no se cierra todo RG3-A2 ni RG-2.
Continúan pendientes preview/status con dobles, CA-RG12 nativa y las puertas
de integración pública/admisión real. No hay nuevo comando disponible al usuario.

Snapshot final: de 304 entradas previas solo cambian estas dos guías y se añade
test/memory-connection-flow.test.js. El resto del código, pruebas, dependencias,
configuración compartida, bóveda y Skill instalada conserva huellas, modos y
dueños. HEAD e659337 y staging vacío permanecen. diff --check, formato y enlaces
locales correctos; heurística sensible sin hallazgos, no garantía absoluta de
ausencia de secretos. Se consultó Mantenimiento de la memoria mediante el MCP
propio; la bóveda no se modifica por este lote local. No se ejecutaron clientes
IA, modelos o candidatos, consultaron cuentas, instalaron dependencias ni
crearon commits o push. Solo se retiraron los fixtures temporales propios tras
validar su identidad; no contienen datos personales ni trabajo del usuario.

## RG3-A2b — Contrato de presentación simulado

Lote autónomo autorizado el 2026-10-15, America/Bogota. Rutas exclusivas:
test/memory-connection-preview-status.test.js, este documento y docs/guias/uso.md.
El objetivo es definir y comprobar la interpretación visible de las salidas,
no entregar un nuevo comando público. No se cambian módulos funcionales,
pruebas anteriores, dependencias, configuración personal, Skills, memorias,
commits o remotos. Se conserva RG-2/CA-RG12 y la puerta RG3-I.

### Separación de contratos

El plan A1a consume observaciones y seis pins declarados; el diagnóstico A1h
consume cinco proyecciones y siete pins diferentes. Ninguna conversión automática
entre ambos está especificada aquí: en especial, no se inventa un pin de árbol
instalado a partir de package/lock ni se convierte coherent en autorización.
La simulación usa fixtures en memoria independientes, con cada contrato completo.

Un harness local al test interpreta opciones y presenta salidas de los núcleos
reales. connect simulado pide un plan; status simulado pide un diagnóstico.
Los proveedores son dobles explícitos y nunca inspectores del host. No es un
adaptador de producción ni una prueba de dispatch público integrado.

| Salida del núcleo | Presentación simulada | Código de salida simulado |
| --- | --- | --- |
| Plan preview | preview, con contadores declarados y sin aplicación | 0 |
| Plan unchanged habilitado | unchanged, no connected | 0 |
| Plan unchanged deshabilitado | unchanged con aviso disabled; no activación | 0 |
| Plan conflict/blocked/invalid o proveedor fallido | error, sin candidato ni huella de reemplazo | 1 |
| Diagnóstico coherent | ok de declaraciones, nativeRead:not-tested | 0 normal/strict |
| Diagnóstico incomplete (ausente o disabled) | warning, sin ocultar el pendiente | 0 normal; 1 strict |
| Diagnóstico blocked/invalid o proveedor fallido | error | 1 normal/strict |
| Opciones inválidas o fuera del alcance | error de argumentos, sin llamar proveedores | 2 |

La vista previa puede mostrar solo el planHash declarado que ya produjo el
núcleo; no lo acepta como permiso, no propone un --expect sustituto ni imprime
candidateServer, identidad, configuración ajena o errores originales. La salida
JSON es un único objeto redactado, con simulation:true y nativeRead:not-tested.
Texto y JSON conservan estado/código; --json no mejora evidencia y --strict
solo cambia el código de salida de warnings de status.

En el harness, connect requiere --agent codex y --transport protected; status
requiere --agent codex. Se rechazan opciones repetidas, incompletas, desconocidas,
agentes/transportes distintos y --strict en connect. --migrate-legacy solo permite
planificar en connect; --apply y --expect siempre se rechazan por estar fuera
de esta etapa, aun juntos. Ninguna combinación escribe, inicia IA o activa MCP.
La clasificación legacy de status y el wiring público completo no se declaran
resueltos por este harness; una migración de preview sigue siendo una intención.

La CLI actual no ofrece --transport protected y su servicio status consume un
informe diferente al plan/diagnóstico aislados. La prueba comprobará el rechazo
real de esa opción antes de cualquier IO, no forzará informes nuevos dentro del
adaptador antiguo ni presentará un doble como funcionalidad ya disponible.

| Criterio | Verificación prevista |
| --- | --- |
| CA-A2B01 | Opciones cerradas válidas/invalidas, duplicadas/incompletas y exclusión de apply/expect antes de llamar dobles |
| CA-A2B02 | Plan real: create, unchanged, disabled, conflictos, impedimentos y migración opt-in; contadores y pins declarados sin aplicación |
| CA-A2B03 | Diagnóstico real: coherent, ausencias, disabled, conflicto, binding/pins contradictorios y entrada inválida; error domina pendientes |
| CA-A2B04 | JSON/texto, strict y códigos coherentes; reporte redactado, simulation y evidencia sin elevar privilegios |
| CA-A2B05 | Guards FS/red/procesos; cero proveedores ante argumentos inválidos; rechazo real de la opción no disponible en runCli; fuentes públicas intactas |
| CA-A2B06 | Contratos de plan/diagnóstico separados, sin pins inventados ni conexión/admisión nativa; errores acotados y entradas preservadas |
| CA-A2B07 | Sintaxis, tandas relevantes/regresión serial y revisión del alcance con evidencia fechada |

Al registrar este contrato los siete criterios están pendientes. Su evidencia
de ejecución se añadirá por separado. Esta simulación no cierra por sí sola
todo RG3-A2, CA-RG310, CA-RG12 o RG3-I, ni declara implementado un servicio público.

### Implementación y evidencia de RG3-A2b

El 2026-10-15 se implementó exclusivamente el harness de presentación en el test
nuevo y se ampliaron las dos guías autorizadas. Los módulos funcionales y sus
interfaces no cambian. El harness es una especificación ejecutable: su parser,
presentador y códigos son simulados; createMemoryConnectionPlan y
summarizeMemoryConnectionEvidence sí son los núcleos reales. runCli real solo
se invoca en los dos casos negativos que rechazan --transport antes de IO.

Los fixtures están completamente en memoria, con rutas inventadas y pins
declarados. No se crean configuraciones, bóvedas o Skills de prueba en disco.
Cada núcleo recibe su propio contrato; probar el contrato del otro devuelve
invalid. No existe un puente implementado entre los seis pins del plan y los
siete del diagnóstico, ni se inventa admisión del árbol instalado. Mostrar un
planHash existente es solo reproducir intención declarada, nunca un permiso.

| Comprobación ejecutada | Resultado real |
| --- | --- |
| node --check test/memory-connection-preview-status.test.js | Código 0 |
| Test nuevo, reporter=tap y concurrency=1 | 57/57; 130.520625 ms; código 0 |
| Quince archivos relacionados: los doce de A2a más preview-status, connect y status, concurrency=1 | 1262/1262; 6100.837416 ms; código 0 |
| Regresión completa serial, intento 1 | 4519 casos: 4517 pasadas, 2 fallidas, cero canceladas/omitidas/todo; 201693.532958 ms; código 1 |
| Diagnóstico aislado por nombre de los dos casos fallidos, sin cambios | 2/2; 539.768417 ms; código 0; no sustituye la regresión global |
| Única repetición completa serial prevista, sin cambios de código/test | 4519/4519; cero fallos/canceladas/omitidas/todo; 198915.46775 ms; código 0 |

La tanda propia y relacionada tienen cero fallos, canceladas, omitidas o todo.
La regresión final usa Node 24.14.1, darwin/arm64: 4462 casos previos más 57
nuevos. No se cambiaron plazos, aserciones, código anterior o dependencias para
obtener ese resultado. El cierre documental se registra después de las tandas;
el test nuevo y los módulos conservan exactamente los bytes probados.

#### Observación conservada: dos fallos del helper sintético previo

El intento 1 falló en NI helper is invoked exactly once, without
shell/input/unapproved env, then revalidated and cleaned, y NI actual N1 helper
with synthetic backend 0, de test/client-managed-preferences-invocation.test.js.
Ambos esperaban completed y observaron timed-out; las duraciones de los tests
fueron 1177.720167 y 1197.458334 ms. Fueron aserciones fallidas, no cancelaciones
por el timeout de 20000 ms del test runner. El fixture declara presupuesto total
de 1500 ms, graceMs 150 y confirmationMs 250. No se modificó ninguno de ellos.

Estas pruebas compilan y ejecutan artefactos sintéticos propios; el segundo
compila el helper con N1_SYNTHETIC_BACKEND, no consulta preferencias personales
ni arranca un cliente IA. Su fuente y test conservaron huellas antes/después.
La ejecución aislada y la única repetición completa pasaron sin cambios. Eso no
demuestra una causa del primer fallo, un problema del host o estabilidad universal.
Tampoco elimina las observaciones históricas distintas de A1e/A1h. Se conserva
el primer resultado y queda pendiente investigar la causa si se abre ese alcance.

| Criterio | Evidencia observada en el alcance aislado |
| --- | --- |
| CA-A2B01 | Argumentos incompletos/duplicados/desconocidos, agentes/transportes ajenos, target adicional/no ficticio, apply/expect separados y juntos; argv no-array o sobredimensionado; cero proveedores llamados |
| CA-A2B02 | Ocho escenarios con plan real, incluidos create, unchanged, disabled, conflicto, unsafe, invalid y legacy sin opt-in; migración opt-in adicional conserva dos migrate y destino disabled, sin aplicación |
| CA-A2B03 | Once escenarios de diagnóstico real; ausencia de informe/Skill/configuración, disabled, contradicción, binding/pins e invalid; error domina configuración ausente más manifiesto bloqueado |
| CA-A2B04 | JSON parseable igual al reporte y texto equivalente; strict conserva el reporte y solo eleva warning de status; salida con simulation:true, nativeRead:not-tested y sin candidateServer/configuración/errores originales |
| CA-A2B05 | Guards sobre APIs comunes FS/red/procesos/fetch/chdir después de imports; cero llamadas prohibidas; runCli real devuelve 2 y ningún stdout ante --transport en connect/status; fuentes públicas intactas |
| CA-A2B06 | Contratos cruzados inválidos, pins independientes, inputs preservados, proveedor fallido/desconocido o dos salidas malformadas acotados; reporte/facts/contadores congelados, autorización/applied/executed siempre false |
| CA-A2B07 | Sintaxis y tandas anteriores, regresión final positiva con primer fallo conservado, revisión de fuentes/flujo y snapshot de alcance de 305 entradas previas |

Los guards son instrumentación de pruebas, no un sandbox general ni una
intercepción exhaustiva del sistema. Los proveedores del harness son propios y
confiables; no se ofrece un adaptador de seguridad para informes arbitrarios.
La salida siempre se identifica como simulación. La tabla no afirma que la CLI
actual implemente JSON/strict del transporte protegido ni que se haya observado
su resultado nativo. La regresión incluye las pruebas existentes de connect y
status, sin sustituir sus servicios ni alterar imports o dispatch.

Quality-gate: **Aprobado con observaciones para el contrato simulado RG3-A2b**.
CA-A2B01 a CA-A2B07 tienen evidencia delimitada; siguen fuera el servicio real de
presentación, legacy en status, el puente entre informes, admisión de runtime/
dependencias, RG-2/CA-RG12 e integración RG3-I. No se declara cerrado todo RG3-A2
o CA-RG310. Las observaciones de temporización previas no se dan por corregidas.

Snapshot final de 305 entradas previas: solo cambian las dos guías autorizadas
y se añade test/memory-connection-preview-status.test.js. Código funcional,
pruebas anteriores, dependencias, configuración compartida, bóveda y Skill
instalada conservan huellas, modos y dueños. HEAD e659337 y staging vacío
permanecen. diff --check, formato y enlaces locales correctos; heurística de
patrones sensibles sin hallazgos, no garantía absoluta de ausencia de secretos.
Se consultaron Estado actual y Mantenimiento de la memoria mediante el MCP
propio; no se edita esa bóveda por este lote local. No se ejecutan clientes IA,
modelos o candidatos de conexión ni se consultan cuentas. No se instalan
dependencias, crean commits o hace push.
