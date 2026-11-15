# R1 — Primera beta privada utilizable

## Estado

- R1.1: verificado para consolidación documental local; autorización del
  2026-10-09 (America/Bogota), con commit local de cuatro documentos.
- R1.2: validación ficticia comprobada y conservada como prueba repetible;
  cierre y commit local de dos archivos autorizados el 2026-10-09.
- R1.3: publicación del contenido revisado confirmada el 2026-10-09 en GitHub
  privado; cierre documental posterior dentro de las dos rutas autorizadas.
- Versión declarada del paquete: `0.1.0`, sin cambio de versión en esta entrega.
- Profundidad: estándar para R1.1; rigurosa para las puertas de escritura,
  conservación de datos y publicación de las etapas posteriores.

Crear esta especificación no autoriza sus etapas futuras, clientes nativos,
inferencias, cuentas, instalación, tags, releases, npm o automatizaciones.

## Problema

La biblioteca tiene herramientas locales y contratos probados, pero muchos
documentos reflejan etapas distintas. Una persona que clone una copia anterior
puede no encontrar los comandos nuevos o confundir una recomendación con permiso
para ejecutar. Tener módulos probados tampoco acredita el recorrido integrado
de un proyecto nuevo, una instalación limpia o una publicación vigente.

## Objetivo

Preparar una primera beta privada que permita comenzar con pasos claros,
identificar qué funciona y comprobar un recorrido completo con datos ficticios
antes de publicar el estado revisado. La coordinación entre clientes sigue
manual; la ejecución automática no es un requisito que se dé por resuelto para
llamar utilizable a la base local.

## Fuera de alcance

- Admitir clientes de IA reales, completar AD-3 o consultar cuentas/consumo.
- Activar modelos, instalar Skills/perfiles o cambiar configuración del usuario.
- Modificar Avisens, otra fuente real o una bóveda de Obsidian.
- Crear una automatización, escribir mensajes entre chats o vigilar carpetas.
- Publicar en npm, hacer público el repositorio o prometer compatibilidad completa.
- Ejecutar GitHub, fetch, push, tags o releases dentro de R1.1.
- Búsqueda semántica, embeddings, nuevos proveedores o autonomía ilimitada.

## Comportamiento actual comprobado

La base revisada para R1.1 es `25df93ac277d2ede40977d2bb3a00884d1faac7e`, con
árbol de trabajo limpio. La referencia local `origin/main` muestra 25 commits
pendientes; no se consultó el remoto y ese número no acredita su estado actual.

- [project-memory](../guias/uso.md) crea y diagnostica memorias, prepara conexiones y
  contiene operaciones de revisión/aplicación con límites explícitos.
- La [fábrica de revisión](../agentes/coordinacion/fabrica.md) propone un recorrido,
  lo lanza solo con la huella aprobada y deja su rastro; las IA externas leen sin escribir.
- La [guía del equipo](../../templates/agent-team/README.md) conserva traspaso manual,
  autoría tutor y autorización separada por rol.
- AD-3 y la inferencia automática de clientes reales permanecen sin admisión.

Evidencia histórica relevante: el candidato funcional de AD-1/AD-2
pasó **3.279/3.279 pruebas** el 2026-10-09, sin fallos, canceladas, omitidas o
todo, con concurrencia 1. Se construyó desde `6cd6811` más los seis archivos de
AD; las consolidaciones posteriores solo cambiaron documentación. La referencia
anterior de 1.001 pruebas del 2026-10-06 pertenece a otra entrega, no a la suma
de todos los módulos actuales. Ninguna cifra es una certificación de producción.

Esta entrega no repite la regresión completa ni una instalación de dependencias.
El entorno local comprobado es macOS con Node.js `v24.14.1` y dependencias ya
instaladas. `package.json` declara Node.js `>=20`; no equivale a haber ejecutado
la regresión completa en todas esas versiones, Linux o Windows.

## Requisitos

### Funcionales

- RF-R01: una [guía inicial](../guias/primeros-pasos.md) parte de un checkout aprobado,
  explica requisitos, raíz de ejecución, comandos y resultados esperados.
- RF-R02: la primera prueba usa solo ayudas y ejemplos ficticios existentes,
  sin instalar software, leer proyectos reales o llamar proveedores.
- RF-R03: el README explica el producto en lenguaje accesible y distingue base
  local, evidencia histórica, validación integrada pendiente y publicación pendiente.
- RF-R04: R1.2 debe unir operaciones existentes en un proyecto/memoria ficticios
  aislados y conservar evidencia de resultados y efectos realmente observados.
- RF-R05: R1.3 debe revisar el destino exacto, privacidad, divergencias y contenido
  saliente antes de un push expresamente autorizado; no usar un remoto por inferencia.

### No funcionales

- Cuatro rutas documentales exactas para R1.1; código, dependencias y configuración
  permanecen intactos. El agregado Git es por archivo y el commit es local.
- Sin secretos, respuestas privadas, inventarios reales o evidencia de cuentas
  en la biblioteca. Los ejemplos continúan siendo ficticios.
- Las fechas de pruebas y observaciones no se renuevan por actualizar un documento.
- Incertidumbre, conflicto o resultado parcial impiden declarar el hito completo.
- Una aprobación de R1.1 no instala, publica ni concede autorización nativa.

## Criterios de aceptación

### R1.1 — Documentación y primeras comprobaciones

- CA-R01: dado un checkout con sus dependencias existentes, las ayudas locales
  de `project-memory`, `agent-task` y `agent-task verify` terminan con exit 0.
- CA-R02: dados los cuatro JSON ficticios existentes, `prepare --json` devuelve
  `prepared-draft`, modelo ficticio `example-alpha-r2` y esfuerzo `brief`;
  ejecución, envío, escritura, admisión y readiness permanecen false, con modelo
  observado desconocido. No se convierte el ejemplo en política real.
- CA-R03: README, guía inicial y guía técnica distinguen clonar la biblioteca,
  preparar un encargo y conectar una memoria. Ninguna de esas acciones se
  presenta como ejecutar automáticamente un equipo o clonar una bóveda.
- CA-R04: los enlaces, anclas, tablas, cercas y finales de línea de las cuatro
  rutas son válidos; se conserva el resto del repositorio y el índice final queda vacío.
- CA-R05: el commit contiene solo las cuatro rutas; no hay push ni instalación.
  La cifra histórica de regresión no se presenta como una ejecución nueva de R1.1.

### R1.2 — Validación integrada ficticia

- CA-R06: un lote autorizado usa exclusivamente directorios temporales propios,
  fuente Git y memoria ficticias separadas; evidencia GitHub simulada y explícita.
  No usa credenciales, API, perfiles instalados, red de proveedores o bóvedas reales.
- CA-R07: inicialización con preview/aplicación autorizada, diagnóstico, estado,
  detección/inspección simuladas y aplicación/registro forman un recorrido coherente.
  Cada paso usa la salida realmente obtenida del anterior; no fabrica una aprobación.
- CA-R08: repetir una operación idempotente no duplica registros ni reemplaza
  contenido distinto. PR abierto, checks adversos, pin/base divergentes y cambios
  ajenos se conservan o bloquean según los contratos existentes.
- CA-R09: la evidencia identifica bytes/revisión, comandos o APIs, resultados y
  límites. El cleanup solo retira recursos propios con identidad comprobada.
  Un fallo no se oculta ampliando permisos, reiniciando contadores o cambiando cliente.

### R1.3 — Publicación privada, propuesta

- CA-R10: destino, rama, privacidad y estado remoto se comprueban bajo permiso
  explícito. Se revisa el historial que efectivamente saldrá, no solo el último diff.
  La presentación y sus referencias de versión/pruebas deben contrastarse con
  la entrega saliente antes de publicar, sin renovar observaciones históricas.
- CA-R11: conflictos, datos sensibles o un destino dudoso bloquean la publicación;
  no se fuerza, borra ni reescribe historia para resolverlos sin otra autorización.
- CA-R12: después de un push autorizado se contrasta el commit remoto exacto y
  se comprueba la privacidad. No se afirma que una descarga o instalación limpia
  funciona sin una prueba separada, acotada y realmente ejecutada.

## Casos límite y errores

- Copia antigua: comparar el hito/revisión disponible; no atribuir comandos nuevos
  al remoto antes de publicarlos ni arreglarlo instalando clientes de IA.
- Falta Node/dependencias: detener la prueba. Su preparación es una acción separada,
  no una instalación silenciosa ni una llamada a una API de pago.
- Datos ficticios caducados: son un ejemplo histórico con tiempo declarado;
  su éxito no verifica disponibilidad hoy en una cuenta real.
- Archivo o rama cambiados: repetir la revisión de la base, no sobrescribir trabajo
  concurrente ni conservar un pin como si siguiera vigente.
- Resultado parcial al escribir notas: registrar lo ocurrido; no hacer rollback
  ciego, marcar sincronizado el PR ni prometer una transacción total.
- Prueba omitida por plataforma: reportarla; no equivale a criterio satisfecho.

## Diseño propuesto

No añadir un runner de IA o un comando de publicación en R1.1. La guía reutiliza
los bins y JSON actuales. R1.2 usa APIs existentes en una fuente/memoria
ficticias y respuestas GitHub simuladas. El lote temporal se ejecutó primero;
después se autorizó conservar [la prueba integrada](../../test/private-beta-integration.test.js)
y actualizar este cierre. No se abrieron cuentas para completar los fixtures.

R1.3 separa auditoría, aprobación y push. Una copia privada en GitHub es un respaldo
de biblioteca, no instalación de clientes, sincronización de Obsidian o admisión
del runtime. No se crea una etiqueta de release por el nombre «beta».

## Datos, privacidad y seguridad

Los contextos operativos siguen fuera del Toolkit. Solo datos genéricos y
ficticios se versionan. La revisión limitada de patrones sensibles no garantiza
ausencia universal de secretos; la revisión humana del historial saliente y
la identificación exacta del destino son puertas adicionales de R1.3.

Elegir tutor/autónomo o un modelo recomendado no concede permiso para enviar
contexto a otro proveedor. Toda entrega real necesita alcance y autorización
verificable en el receptor. Esta especificación no cambia las reglas de autoría
de un proyecto ni los requisitos de AD-3.

## Alternativas consideradas

- Esperar a la automatización nativa: no hace falta para usar las herramientas
  locales ya construidas; se conserva como una evolución separada, no como concluida.
- Publicar inmediatamente: se pospone hasta la validación y revisión saliente.
- Probar con AVISENS: se descarta para este hito; datos ficticios permiten acotar
  efectos sin modificar un proyecto o memoria reales.

## Riesgos y reversión

La principal confusión es presentar documentación o fixtures como prueba de una
cuenta, instalación limpia o producción. Los estados separados y evidencia fechada
evitan esa conclusión. R1.1 es documental: puede retirarse mediante un cambio
revisado sin migraciones o resets. La limpieza futura no incluye proyectos reales.

## Plan de tareas

- [x] R1.1: cuatro documentos, ayudas/ejemplo existentes, QA y commit local.
  Archivos: este documento, `primeros-pasos.md`, `README.md`, `uso.md`.
- [x] R1.2: lote aislado ejecutado; recorrido y bloqueos conservados en
  `test/private-beta-integration.test.js`; cierre, regresión y commit local de
  ese test y este documento. Código de producción intacto; sin publicación.
- [x] R1.3: historial/destino revisados, push autorizado y contenido publicado
  verificado por SHA y privacidad; cierre documental posterior. Sin tags,
  releases, npm, instalación de clientes o inferencia.

## Evidencia histórica de cierre R1.1

Comprobaciones ejecutadas el 2026-10-09 (America/Bogota), desde la raíz del
Toolkit y con las dependencias existentes. Sin instalación, cuentas, red de
proveedores, proyectos reales, llamadas de IA, GitHub remoto o publicación.

| Criterio R1.1 | Evidencia |
| --- | --- |
| CA-R01 | Las tres ayudas locales finalizaron con exit 0; Node observado `v24.14.1` |
| CA-R02 | Ejemplo existente: `prepared-draft`, `example-alpha-r2`, `brief`; indicadores de ejecución/envío/escritura/admisión false, observaciones vacías y verificación de modelo unknown |
| CA-R03 | Guía y presentación revisadas: biblioteca distinta de bóveda; borrador distinto de permiso; entrega manual distinta de ejecución automática |
| CA-R04 | 39 referencias locales, incluido el logo; tablas, cercas y finales de línea comprobados; solo cuatro rutas del lote |
| CA-R05 | Staging por cuatro rutas exactas y verificación de bytes del commit; sin push. La regresión de 3.279 pruebas conserva su fecha histórica y no se repitió |

Comparación con la base de 235 archivos: 233 intactos, solo README y guía de
uso actualizados, dos documentos nuevos; ningún archivo previo borrado. Escaneo
limitado de patrones sensibles sin hallazgos, no garantía universal de ausencia
de secretos. Código, ejemplos y contratos conservaron sus bytes.

Quality-gate de aquella entrega: **Aprobado para R1.1 documental**. En ese cierre
solo estaba completada una de tres entregas; R1.2/R1.3 no se dieron por verificadas
al aprobar el documento. Ese resultado histórico se conserva, sin atribuirle
las comprobaciones posteriores.

## Cierre de R1.2 — 2026-10-09

Base de consolidación: `93df8fcde4455165adcdcb6af2adf17b636fc8de`.
El usuario autorizó conservar el recorrido como prueba de integración, registrar
este cierre y crear el commit local de las dos rutas exactas, sin push. No se
modificaron APIs, esquemas, dependencias, perfiles instalados, proyectos reales
o memorias de Obsidian. Tampoco se concedió admisión de clientes nativos.

El test contiene **una prueba de integración** con diez pasos y siete casos
adversos, no diecisiete pruebas independientes. Cada ejecución crea un directorio
temporal propio, fuente y memoria Git ficticias separadas y un home de conexión
ficticio; no cambia el HOME del proceso ni copia autenticación.

| Criterio R1.2 | Evidencia ejecutada |
| --- | --- |
| CA-R06 | Raíz temporal física 0700 y fuente/memoria separadas; GitHub y consulta MCP simulados; el recorrido usa solo Git local del fixture con entorno mínimo, hooks vacíos y configuración global/sistema deshabilitada |
| CA-R07 | Preview e init, repetición idempotente, doctor/status, plan/inspect, preview/aplicación autorizada, registro y cierre componen el recorrido usando las salidas anteriores |
| CA-R08 | Repetir init/apply/record conserva bytes, identidad y tiempos; PR abierto, checks fallidos, pin incorrecto, HEAD divergente, nota distinta, cambio ajeno y PR ya revisado bloquean sin escribir |
| CA-R09 | Snapshots de archivos/directorios y SHA-256; fuente/home ficticios intactos; solo una nota y después el registro cambian; índice preservado por las APIs; restauración de APIs instrumentadas y cleanup por identidad |

`doctor` terminó ok en la memoria limpia. `status` informó warning por tres
conexiones pendientes en el home ficticio: es esperado, no una conexión real
instalada. Después de aplicar y registrar, doctor señaló únicamente cambios Git
de las dos notas. El commit de esas rutas ocurrió solo en la memoria ficticia;
el diagnóstico posterior fue ok y el plan quedó clean con un PR revisado,
sin duplicados. No se contactó el remoto configurado en el fixture.

La instrumentación cooperativa intercepta procesos/red de Node y se restaura
incluso ante fallo. **No es un sandbox del sistema operativo**, contención atómica
o prueba sobre la disponibilidad, políticas, cancelación o consumo de un cliente
real. El estado upstream del fixture es una referencia local simulada; no prueba
estado remoto vigente.

Resultados de consolidación, ejecutados en macOS con Node.js `v24.14.1`:

- `node --check test/private-beta-integration.test.js`: exit 0.
- Prueba enfocada final: **1/1**, exit 0; diez pasos y siete bloqueos comprobados,
  sin fallos, canceladas, omitidas o todo. Duración observada: 3474.830042 ms.
- Regresión completa del candidato final aislado: **3.280/3.280**, exit 0;
  sin fallos, canceladas, omitidas o todo. Concurrencia 1 y duración observada
  187289.325292 ms; no es una garantía de rendimiento.
- Candidato: base `93df8fc` más solo el nuevo test, enlazando las dependencias
  existentes sin reinstalarlas. La primera pasada también pasó, pero tras
  limitar el entorno de Git se repitieron enfocada y completa con los bytes finales.
- SHA-256 del test probado:
  `e5daa2d3f259a63c5dfa60beda67855842836891f481f3d395f36691e8d56660`.
  Después de la regresión solo se añadió este cierre documental.
- El caso POSIX declara Windows no validado; no se ejecutó una instalación limpia
  ni regresión completa en otras versiones de Node o sistemas operativos.

Comparación con 237 archivos previos: 236 intactos, únicamente este documento
actualizado y un test nuevo; ningún archivo previo borrado. Formato, enlaces y
escaneo limitado de patrones sensibles comprobados, sin garantía universal de
ausencia de secretos. Staging por dos rutas exactas, commit local e índice final
vacío; sin push. La copia aislada propia se retira sin borrar dependencias originales.

Quality-gate de R1.2: **Aprobado para validación ficticia y consolidación local**.
En ese cierre había dos de tres entregas completadas y R1.3 aún no se ejecutaba.
Ese conteo histórico no representa un porcentaje de capacidades de modelos o
del alcance global futuro del Toolkit.
Las referencias de presentación anteriores conservan su evidencia histórica;
su contraste con esta entrega forma parte de la puerta de publicación R1.3.

## R1.3 — Revisión previa y publicación autorizada

Revisión del 2026-10-09 (America/Bogota), antes de modificar o publicar:

- Destino confirmado: `Jcabr3ra1/agent-toolkit`, visibilidad private, rama `main`.
  No se consultó autenticación ni cuentas de clientes de IA.
- Remoto observado: `5e3fad16039546309e5f5f28d1b7be85f6cccaba`.
  Coincidía con la referencia local `origin/main`; no se ejecutó fetch.
- HEAD revisado: `107a119e09e0a0b2da12dc96dbea515bc854f0fa`.
  Los 27 commits pendientes son un avance fast-forward desde ese remoto.
- Inventario histórico: 27 árboles, 258 blobs distintos, 3.229.030 bytes y
  238 rutas; 172 rutas difieren entre la base remota y HEAD.
- Escaneo limitado y revisión contextual: 19 coincidencias de datos ficticios
  en pruebas negativas, sin secretos reales confirmados. Sin rutas de bóvedas,
  encargos privados o almacenes de credenciales versionadas. No es una garantía
  universal de ausencia de secretos o datos sensibles.
- El único blob binario revisado es el logo, idéntico al de la base remota.
  No hay enlaces simbólicos versionados en los árboles inspeccionados.
- Respuestas remotas: repositorio no archivado/deshabilitado, push permitido
  por el servidor, rama sin protección declarada, cero reglas de rama,
  workflows o webhooks activos. Es información observada, no consentimiento
  humano ni garantía permanente de que no puedan cambiar las políticas.

El usuario autorizó actualizar únicamente README y este registro, crear los
commits documentales necesarios y publicar el historial revisado en
`origin/main`. La publicación no incluye force, tags, releases, npm, cambios de
visibilidad, activación de CI, instalaciones, automatizaciones o inferencia.

Quality-gate previo: **Aprobado con observación documental**. El README aún
citaba 3.279 pruebas y el estado anterior a R1.2; se ajusta a la regresión
documentada de 3.280, sin repetir pruebas de código ni renovar su fecha.
Las comprobaciones anteriores de R1.1/R1.2 conservan sus alcances y resultados.

Antes de cada push se revalidarán destino, privacidad, rama y SHA remoto
esperado, además de los bytes e índice locales. Divergencia, rechazo, hooks
inesperados o cambio de privacidad detienen la operación sin forzar ni
sobrescribir. Solo después del primer envío verificado se registrará el cierre
real en otro commit documental dentro de estas dos rutas autorizadas.

### Resultado remoto verificado — 2026-10-09

La autorización incluyó publicar el historial y registrar su cierre con los
commits documentales necesarios, sin ampliar las dos rutas. Se creó el commit
de preparación `7ed7c304d309dc362a865287f58ade78dd504450`, solo con README y
este documento. La revisión posterior añadió esas dos versiones: 28 commits,
260 blobs distintos y las mismas 19 coincidencias ficticias, sin nuevos
hallazgos de publicación.

El preflight inmediato volvió a confirmar destino único, árbol limpio,
repositorio private, rama `main`, SHA remoto esperado, ausencia de divergencia,
reglas de rama, workflows y webhooks activos. No se desactivaron protecciones
ni hooks para publicar. Se ejecutó un push normal de `HEAD:refs/heads/main`,
sin force y con publicación automática de tags deshabilitada solo para ese comando.

Resultado: exit 0. La consulta posterior independiente confirmó:

- `Jcabr3ra1/agent-toolkit`: private, no archivado ni deshabilitado.
- `refs/heads/main`: `7ed7c304d309dc362a865287f58ade78dd504450`, idéntico al HEAD
  local enviado y a `origin/main` tras el push.
- Código de producción, dependencias y el test con regresión de 3.280 pruebas
  conservados; no se repitió esa regresión para cambios exclusivamente documentales.

Este registro y el estado final del README se publican en un segundo commit
documental dentro de la misma autorización, después de esa verificación real.
El segundo envío vuelve a comprobar privacidad y SHA remoto esperado. La evidencia
anterior identifica el primer contenido publicado; no intenta contener la huella
de su propio commit. El SHA final del cierre se contrasta de nuevo después del envío.

Quality-gate: **Aprobado para publicación privada del alcance revisado**.
R1 tiene **3 de 3 entregas completadas**: guía, integración ficticia y publicación
del contenido comprobada. No es una release de npm ni un runtime nativo admitido.
La instalación limpia, plataformas adicionales, automatización completa y AD-3
siguen pendientes de sus propios diseños, evidencias y permisos.

## Preguntas abiertas

- Casos o plataformas adicionales de integración, si se decide ampliar cobertura;
  no se consideran probados por este recorrido ficticio.
- Disponibilidad y políticas del remoto para futuras publicaciones; los valores
  observados en R1.3 no se heredan como autorización o garantía permanente.
- Entornos adicionales e instalación limpia que se decidan validar después;
  no se comprometen ahora ni se afirman comprobados.
