# Evaluación inicial de modelos por rol

## Estado y objetivo

- Fecha: 2026-10-02.
- Estado: piloto autorizado por lote; ejecución parcial, sin perfiles activados.
- Profundidad: estándar, con puertas de privacidad y consumo antes de ejecutar.
- Base aprobada: [selector v2](agent-model-preference.md), registrado en `cf048f1`.
- Consolidación documental: 2026-10-09. Los resultados parciales históricos
  conservan sus fechas y no se convierten en perfiles activos.

Convertir observaciones del [inventario](agent-model-inventory.md) en evidencia
acotada de calidad por rol, versión y esfuerzo. La aprobación del selector no
aprueba modelos reales. Este piloto no activa enrutamiento ni configura clientes.

Spec-driven-development separa la preparación de las llamadas; OpenAI Docs
guía el contraste del cliente y esfuerzo, no acredita cuentas. La biblioteca
contiene este protocolo genérico; las versiones, menús y resultados reales
permanecen fuera de Git y Obsidian.

## Problema y comportamiento actual

El selector recibe clasificación, política, disponibilidad y evaluaciones
explícitas. No prueba modelos, consulta cuentas ni persiste historial.
Los ejemplos son ficticios y no pueden convertirse en política real por copia.

El inventario privado anterior conserva observaciones y declaraciones de
suscripciones, pero no demuestra el método de autenticación actual, consumo
incluido, identidad de cada respuesta ni calidad para los roles nuevos.
Las observaciones posteriores no sobrescriben las anteriores.

## Alcance del piloto autorizado

Seis ejecuciones principales como máximo: dos ajustes locales de esfuerzo por
cliente, con el mismo ejercicio para las dos ejecuciones de ese cliente.
No se comparan marcas con una clasificación universal ni se promete una
estadística representativa a partir de una muestra tan pequeña.

| Participante | Rol evaluado | Ejercicio | Lo que NO habilita |
| --- | --- | --- | --- |
| Coordinador | `reviewer` / `diagnostic` | Detectar defectos y proponer comprobaciones | Ejecución de agentes o aprobación de migraciones |
| Especialista en código | `tutor` / `tutoring` | Explicar un único paso y esperar al usuario | Escritura automática o un proyecto completo |
| Receptor de propuesta | `proposer` / `proposal` | Transcribir una solución canónica exacta como texto | Rol `executor`, edición de archivos o aplicación autónoma |

El tercer ejercicio es deliberadamente textual. Evaluar que un modelo transcribe
código no demuestra que su cliente lo aplica correctamente. La aplicación en
archivos de prueba aislados y las herramientas requieren otro piloto autorizado.

Fuera de alcance: código y datos de proyectos, memoria, herramientas de agentes,
MCP, hooks, Skills globales, subagentes, arquitectura compleja, seguridad,
compras, API keys, facturación adicional, defaults persistentes, instalación,
actualización, automatización, commit y push.

## Requisitos

### RF-E01. Preflight antes de cada ejecución

Comprobar cliente/variante/versionado y opciones mediante documentación y ayuda
local, sin iniciar un turno. Un wrapper no hereda comandos del cliente estándar.
Separar oferta, disponibilidad declarada y evaluación. Las fechas originales
de oferta y acceso no se renuevan para evitar caducidad.

Ayuda, versión y estado de autenticación son invocaciones del cliente aunque
no pidan una respuesta de IA. Requieren revisión y autorización específica de
sus efectos de arranque; no ejecutarlos para descubrir si son inocuos. Las bases
posteriores de diagnóstico nativo y de autenticación (ya retiradas) mantenían permisos
separados. Esta consolidación no renueva el lote original ni autoriza esas recetas.

La revisión privada debe resolver para cada ejecución:

- Modelo solicitado concreto, familia, ordinal revisado y fuentes; sin `latest`
  ni un alias cuya resolución esté pendiente.
- Ajuste de esfuerzo admitido por ese modelo/cliente y cómo se pide sin guardar
  un default. Primer ajuste ligero y segundo equilibrado son orientaciones,
  no equivalencias numéricas entre proveedores.
- Autorización humana, sesión de suscripción y declaración de uso incluido,
  sin API, créditos extra ni consumo adicional autorizado. Si queda desconocido,
  bloquear esa ejecución y no leer credenciales para completar el registro.
- Herramientas, hooks y conexiones deshabilitados mediante controles comprobados;
  una frase del prompt no es una barrera de seguridad.
- Workspace de prueba sin proyectos reales, timeout externo y observabilidad
  suficiente de estado y efectos. Si un cliente no permite el aislamiento,
  mantenerlo pendiente; no desactivar permisos ni inventar flags.

Los dos proveedores conservan datos y ejecuciones independientes.

### RF-E02. Presupuesto y parada

Máximo de seis inicios principales, secuenciales, con 120 segundos por inicio
y 720 segundos acumulados de ejecución. Un intento fallido consume su plaza y
su tiempo; no hay reintentos, escaladas, renovaciones de contador o fallback.
El tiempo de revisión humana no se presenta como tiempo de inferencia.

No lanzar más de un turno de respuesta por ejecución ni delegar a auxiliares.
Comprobar los controles que el cliente realmente permite; si el número interno
de llamadas o auxiliares no es observable/controlable, dejarlo como limitación
y no afirmar un límite estricto de peticiones al proveedor. No iniciar la
modalidad estricta si depende de controles inexistentes.

Cada llamada tiene entrada y salida breves. Cuota agotada, autenticación dudosa,
consumo adicional, error de entorno, cambio de modelo o aislamiento fallido
detienen la ejecución afectada. No cambiar de proveedor para completar el cupo.
El usuario puede detener el piloto; lo consumido no se recupera ni se oculta.

### RF-E03. Un ejercicio pequeño y verificable

Función ficticia `canReserve(available, requested)`: ambos argumentos deben ser
enteros seguros de JavaScript; `available >= 0`, `requested > 0`, y
`requested <= available`. Cualquier entrada inválida devuelve `false`.
La función es pura, devuelve un booleano y no modifica entradas o estado externo.

| Caso | Resultado |
| --- | --- |
| `(4, 2)` | `true` |
| `(4, 4)` | `true` |
| `(4, 5)` | `false` |
| `(4, 0)` y `(0, 1)` | `false` |
| `(-1, 1)` y `(4, -1)` | `false` |
| `(4, 1.5)` y `(4.5, 1)` | `false` |
| `(4, "2")`, `(null, 1)` y `(4, undefined)` | `false` |
| `(Infinity, 1)` y `(4, NaN)` | `false` |
| Valores superiores a `Number.MAX_SAFE_INTEGER` | `false` |

Para el revisor, proporcionar la implementación defectuosa que solo compara
`requested < available`. Debe identificar la igualdad válida que se rechaza y
la ausencia de validación, con ejemplos concretos, sin afirmar que ejecutó tests.

Para el tutor, proporcionar ese mismo defecto y la regla. Debe explicar el
objetivo y `Number.isSafeInteger`, dar un único bloque acotado para ese paso,
indicar una comprobación y esperar al usuario. No debe editar, ejecutar,
completar etapas posteriores ni inventar que el usuario ya verificó el código.

Para el proponente, proporcionar una solución canónica fijada antes de enviar
el encargo. Debe devolver solo ese bloque, sin mejoras, herramientas ni archivos.
La comparación normaliza únicamente saltos de línea y el cercado Markdown
acordado; no oculta cambios funcionales. No recibe el inventario de otro proveedor.

Todos los prompts, solución canónica y comprobaciones se revisan y fijan antes
de llamar. No cambiar la rúbrica después de ver una respuesta para hacerla pasar.

### RF-E04. Evidencia mínima, privada y honesta

Registrar por ejecución: identificador, rol/categoría/dificultad/riesgo, cliente
y versión, modelo/ajuste solicitado, hash de entrada, tiempos, presupuesto
acumulado, estado de salida y evaluación de cada criterio.

Separar modelo/ajuste solicitado de modelo/ajuste observado. Si la metadata no
los identifica para esa respuesta, conservar `unknown`; el autorreporte del
modelo no es prueba independiente. Un cambio de identidad o esfuerzo impide
atribuir el resultado al perfil solicitado sin resolución humana.

Guardar respuestas mínimas pertinentes y resúmenes de diagnóstico; nunca emails,
IDs de cuenta, credenciales, logs extensos o razonamiento interno. Las opciones
de no persistencia y los registros inevitables del cliente se revisan antes de
ejecutar; no prometer que un CLI no escribe ningún registro por defecto.

Destino acordado: una revisión nueva bajo la carpeta privada Agent-Handoffs,
fuera de Git, Obsidian y sincronización. La ruta exacta y la evidencia de cuentas
permanecen en el registro privado del lote, no en la biblioteca reutilizable.
No modificar el piloto tutor ni los inventarios anteriores.

### RF-E05. Revisar antes de convertir a política

Resultados por criterio: `pass`, `fail`, `not-run` o `unknown`, con evidencia.
No ejecutar código recibido arbitrariamente para probarlo: primero revisar
alcance y efectos; la verificación ejecutable posterior requiere aislamiento
y autorización. La transcripción puede verificarse por comparación sin ejecutarla.

Un caso favorable acredita solo el ejercicio observado. No prueba herramientas,
multimodalidad, contexto máximo, otras categorías, riesgos altos o versiones.
Un prompt de tamaño determinado aceptado no acredita por sí solo el contexto
máximo. No rellenar `verifiedCapabilities.maxContextTokens` sin prueba pertinente.

No crear un catálogo activo que deba inventar datos obligatorios para recomendar.
Modelo o esfuerzo real desconocidos mantienen pendiente la atribución exacta;
las conclusiones de calidad pueden conservarse como observaciones provisionales.
El perfil sigue `candidate` hasta revisar toda la evidencia y aprobar el alcance.

La política privada se construye posteriormente con el contrato `2.0.0`,
solo para combinaciones evaluadas y aprobadas. Revalidar disponibilidad antes de
usarla. Los permisos de escritura no cambian por aprobar un modelo de tutoría.

## Criterios de aceptación

| ID | Verificación |
| --- | --- |
| CA-E01 | Identidad y comandos pertinentes al cliente; variante no resuelta queda pendiente |
| CA-E02 | Sin confirmación de suscripción/consumo y autorización no hay inferencia |
| CA-E03 | Como máximo seis inicios, fallidos incluidos; tiempos conservados sin reintentos |
| CA-E04 | Mismo ejercicio/rúbrica por cliente entre esfuerzos; ajustes no equiparados por marca |
| CA-E05 | Revisor detecta los dos defectos y aporta contraejemplos, sin afirmar tests no ejecutados |
| CA-E06 | Tutor entrega un paso explicado y espera; no escribe ni se atribuye autoría del usuario |
| CA-E07 | Proponente transcribe la solución fijada sin convertirlo en evaluación de aplicación |
| CA-E08 | Salida y metadata discrepantes no se atribuyen silenciosamente al perfil solicitado |
| CA-E09 | Sin tools/proyectos/auxiliares; un control no disponible bloquea el modo estricto |
| CA-E10 | Evidencia privada mínima; piloto e inventarios históricos intactos |
| CA-E11 | Aprobación por alcance exacto; capacidades no probadas y perfiles nuevos quedan pendientes |
| CA-E12 | Biblioteca/CLI/memoria/defaults no cambian por ejecutar este piloto |

CA-E01 a CA-E12 son la rúbrica del piloto. Los resultados parciales registrados
al final no implican que todos los casos o criterios estén completados.

## Plan original y puertas del piloto

Esta lista conserva el estado parcial del piloto, no un permiso vigente para
completar plazas pendientes. Las bases offline y fixtures construidas después
son etapas separadas; no añaden respuestas al piloto, reinician su presupuesto
ni resuelven atribución de modelo/esfuerzo o acceso privado.

- [x] E1. Definir piloto, ejercicios, límites y revisión en esta especificación.
- [x] E2a. Recibir autorización del lote, destino privado y condiciones de consumo;
  fijar ejercicios, prompts y rúbrica antes de cualquier llamada.
- [ ] E2b. Resolver todas las puertas de preflight de cada caso. La autorización
  humana no acredita por sí sola autenticación, coste o aislamiento del cliente.
- [ ] E3. Ejecutar los casos elegibles autorizados, registrar intentos y revisar
  criterios sin reintento. No aprobar una combinación no observada.
- [ ] E4. Revisar conclusiones; solo con autorización, convertir las combinaciones
  completas a catálogo/política privada y probar recomendación local sin inferencia.
- [ ] E5. Especificar la aplicación autónoma y los adaptadores por separado.

No se crea un runner ni se integra un comando CLI con este piloto.
Una autorización por lote evita pedir permiso por cada respuesta, sin ampliar
los límites del lote. Commit, push y activación de política requieren permiso aparte.

## Fuentes y riesgos

Fuentes oficiales consultadas el 2026-10-02; no demuestran disponibilidad privada:

- [OpenAI: modelos y esfuerzo](https://learn.chatgpt.com/docs/models).
- [Codex: modo no interactivo](https://learn.chatgpt.com/docs/non-interactive-mode).
- [OpenAI: planes y consumo](https://learn.chatgpt.com/docs/pricing).
- [Claude: versiones, esfuerzo y límites](https://code.claude.com/docs/en/model-config).
- [Claude: opciones de ejecución](https://code.claude.com/docs/en/cli-reference).

Documentación pública, ayuda local y declaraciones de cuenta se contrastan,
no se sustituyen unas por otras. Un esfuerzo explícito puede estar limitado por
el cliente; pedirlo no demuestra cuál se aplicó. Disponibilidad y cuotas cambian.
Una única respuesta por ajuste no prueba fiabilidad general ni superioridad.

Alternativas no adoptadas: probar todos los modelos, fijar siempre el más grande,
comparar versiones entre familias o usar proyectos reales como benchmark inicial.
Reversión: detener nuevas llamadas conservando su evidencia privada, sin borrar
inventarios, resetear repositorios o cambiar autenticación para continuar.

## Evidencia histórica de preparación y ejecución parcial

La revisión de esta propuesta comprobó categorías y roles contra el contrato
existente, los dos enlaces locales, tres tablas y formato. Los 114 archivos
previos inspeccionados conservaron sus huellas SHA-256. Se creó únicamente este
documento; no hubo commit, push, inferencias o cambios a inventarios/bóvedas.

Se contrastaron las versiones y ayudas de los tres ejecutables presentes con
red y escrituras denegadas, entorno mínimo y lecturas de configuración y
credenciales del usuario bloqueadas, fuera de los proyectos. La identificación
es parcial: no verifica integridad editorial, autenticación o metadata de una
respuesta. No se guardaron las salidas completas en la biblioteca ni se adoptó
un inventario activo a partir de ellas. La ayuda de cada caso deberá contrastarse
de nuevo cuando se prepare su comando concreto.

Las pruebas funcionales del selector aprobado no se repitieron para este cambio
exclusivamente documental. Tras la autorización se preparó el lote privado y se
contrastaron controles oficiales con ayuda local y consultas de autenticación
sin inferencias. Tras resolver una puerta de autenticación y recibir confirmación
humana de uso adicional desactivado, se inició un caso con controles fijados.
Su guarda de inicio lo detuvo sin recibir respuesta. Posteriormente se fijó
un control adicional de plugins solo para el proceso; el segundo caso del mismo
cliente confirmó un init vacío y completó una respuesta de tutoría textual.
Dos inicios contados, sin reintentos, cambio de proveedor o activación de perfiles.
Los otros clientes permanecen pendientes por sus propias puertas. Los motivos,
marcas temporales y fuentes están en la evidencia privada.

El primer caso carece de respuesta y no acredita calidad o esfuerzo. El segundo
tiene una observación favorable para el ejercicio, pero su esfuerzo efectivo no
se reportó; la atribución exacta permanece pendiente. No permite comparar los
dos esfuerzos ni activar una combinación sin evidencia completa y aprobación.
Resolver un bloqueo no renueva el presupuesto del lote. No hubo cambios en la
CLI, memoria, defaults o políticas reales. Actualización documental: 2026-10-03.

## Consolidación documental — 2026-10-09

El usuario autorizó precisiones y commit local de cuatro documentos, sin push,
nuevas inferencias, clientes reales ni consultas a cuentas. Se preservaron los
dos inicios históricos, atribución incompleta, fechas, rúbrica y presupuesto.
No se volvió a leer la evidencia privada ni se calificaron respuestas nuevas.

El selector produce una recomendación a partir de datos declarados. Su salida
no verifica disponibilidad real, autenticación, modelo de una respuesta o calidad
por rol. Un ejemplo ficticio válido no se transforma en catálogo de producción.

Contraste documental puntual con OpenAI Docs, separado de las fuentes del piloto:
la [documentación de modelos](https://learn.chatgpt.com/docs/models) distingue la
elección de modelo/esfuerzo de los permisos del workspace. Elegir otro modelo
no modifica esos permisos ni concede acceso. Esta referencia no verifica una
cuenta particular y no se incorporó un modelo o esfuerzo nuevo al inventario.

Quality-gate: **Aprobado para consolidación documental**, no para activar perfiles.
Ayuda y preparación ficticia locales, enlaces, tablas y formato comprobados;
código intacto y regresión funcional no repetida. AD-3 y las evaluaciones reales
pendientes conservan sus propios requisitos de evidencia y autorización.
