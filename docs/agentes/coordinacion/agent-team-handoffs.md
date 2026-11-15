# Equipo de agentes mediante archivos compartidos

## Estado

- Especificación aprobada por el usuario el 2026-10-02; plantillas documentales
  creadas y piloto tutor manual completado con observaciones de proceso.
- Fecha: 2026-10-02.
- Consolidación documental: 2026-10-09; preparación y verificación locales
  disponibles, transferencia entre clientes todavía manual.
- Profundidad: estándar, con controles de autoría, privacidad y concurrencia.
- Alcance: proyectos conectados a Agent-Toolkit, no exclusivamente AVISENS.

Esta etapa es documental. No ejecuta agentes, instala configuraciones, selecciona
modelos, cambia permisos ni activa un modo autónomo en un proyecto. No modifica
el código de AVISENS ni la memoria de Obsidian.

## Problema y objetivo

El usuario quiere coordinar Codex y Claude sin copiar conversaciones
completas ni contratar consumo adicional por API. Necesita conservar la opción
de aprender escribiendo el código y la de delegar una implementación delimitada.

El objetivo inicial es un traspaso manual asistido por archivos: cada agente lee
un encargo específico y devuelve una entrega comprobable. El usuario indica
cuándo pasar al siguiente agente. La futura ejecución local por CLI será otra
etapa, condicionada a las cuentas, versiones y permisos reales.

## Comportamiento actual comprobado

- Agent-Toolkit contiene herramientas de memoria, el selector de modelos y la
  [fábrica de revisión](fabrica.md). No existe un ejecutor automático admitido de
  este equipo real: el traspaso entre clientes sigue siendo manual con las plantillas.
- [Modos de trabajo](agent-work-modes.md) propone `tutor` y `autonomous`, pero
  su integración no es una configuración global instalada por este documento.
- Las conexiones de memoria no constituyen un canal de mensajes entre clientes.
- Se probó una tarea documental en tutor: Claude propuso, el usuario escribió y
  Codex revisó el archivo real. Ese piloto histórico no probó aplicación
  autónoma ni envío automático; no se reescribe para atribuirle trabajo posterior.

## Responsabilidades propuestas

| Rol inicial | Responsable | Entrega |
| --- | --- | --- |
| Coordinación y revisión | Codex | Encargo acotado, criterios y revisión con evidencia |
| Diseño de implementación o tutoría | Claude | Un paso explicado o una propuesta precisa de cambios |
| Aplicación y comprobaciones | Claude | Cambios aplicados dentro del permiso y resultados de pruebas |
| Autoría en tutor y decisiones de alcance | Usuario | Código del paso y autorizaciones necesarias |

Son roles configurables, no una clasificación permanente de calidad por marca.
Codex no aplica código por defecto en este reparto. Una excepción necesita
autorización explícita y no se convierte en una preferencia permanente.

## Requisitos funcionales

### RF-01. Dos recorridos separados

En `tutor`:

1. Codex prepara objetivo, alcance, contexto mínimo y comprobación esperada.
2. Claude entrega un único paso verificable: ubicación, código y explicación.
3. El usuario escribe el código y comunica que terminó.
4. Codex revisa el resultado real y la evidencia; si falta algo, el paso sigue
   pendiente. Claude puede preparar la corrección del mismo paso.
5. Solo un paso verificado habilita el siguiente.

Ningún agente aplica código en tutor. Claude puede realizar un diagnóstico no
mutante permitido si se le encarga expresamente. Las instrucciones del proyecto mandan
sobre cualquier plantilla; si restringen la entrega de soluciones, se respetan.

En `autonomous`:

1. Codex prepara el encargo autorizado y los criterios de aceptación.
2. Claude inspecciona la versión indicada y propone cambios sobre rutas exactas.
3. Con autorización directa, Claude verifica vigencia y permisos, aplica la
   propuesta aprobada y ejecuta las comprobaciones acordadas.
4. Codex revisa el diff y la evidencia, y devuelve una corrección delimitada o
   una conclusión de revisión.

Elegir un modo no ejecuta automáticamente el recorrido ni autoriza commits,
publicación, memoria o acciones destructivas. No se pregunta de nuevo por una
acción ya incluida en un permiso explícito vigente.

### RF-02. Archivos de encargo y entrega

Se proponen tres tipos de documento por tarea:

- `01-encargo.md`: problema, criterios, contexto permitido y autorizaciones.
- `02-propuesta.md`: respuesta de Claude para el paso o la implementación.
- `03-revision.md`: resultados de aplicación, pruebas y revisión final.

Cada uno identifica `projectId`, `taskId`, modo y revisión del encargo. También
registra quién lo redactó, a quién se dirige y qué entrega consume. No se usan
conversaciones completas como contrato ni se modifica una entrega anterior para
ocultar un fallo: una corrección crea una revisión nueva.

La plantilla de revisión separa evidencia del ejecutor y conclusión
del revisor en secciones distintas. Claude registra su resultado; Codex lo
contrasta sin convertir una afirmación de éxito en prueba independiente.

Un lector no vigila estos archivos automáticamente. En esta base el usuario
indica al agente qué ruta leer y cuándo continuar. Tampoco se escriben mensajes
en otros chats por el mero hecho de existir un archivo compartido.

### RF-03. Base exacta y cambios concurrentes

El encargo identifica repositorio físico, rama, HEAD completo y estado inicial
del árbol de trabajo. Para cada archivo existente que se cambiará, la propuesta
incluye ruta relativa exacta y SHA-256 de los bytes inspeccionados. Para archivos
nuevos, declara explícitamente que no deben existir.

HEAD solo no demuestra vigencia si hay cambios locales. El ejecutor compara
ambas cosas antes de aplicar; el revisor inspecciona el diff real después.

- Cambios locales iniciales se enumeran sin incluir secretos; ante solapamiento,
  incertidumbre o un destino diferente, bloquear, no sobrescribir ni resetear.
- Si una huella, HEAD, rama o revisión del encargo difiere, solicitar una nueva
  propuesta basada en el estado real. No aplicar con aproximación o fuerza.
- La propuesta contiene diffs precisos o bloques completos inequívocos, indicando
  adición, reemplazo y destino; una instrucción vaga no es una entrega aplicable.
- Un solo escritor funcional por tarea. Claude propone y aplica en autónomo;
  el usuario escribe en tutor. No editar simultáneamente desde varios agentes.

El contrato original exige estas comprobaciones al receptor; los archivos por
sí solos no las imponen. El verificador local posterior compara bytes listados
bajo un contrato fijado, pero no comprueba calidad, permisos o toda la base Git.
La automatización completa deberá probar sus restricciones antes de prometerlas.

### RF-04. Autorización distinta de contenido

El encargo enumera acciones autorizadas y prohibidas, junto con la instrucción
del usuario que origina el permiso. El agente receptor debe comprobar esa
autorización en su sesión o en un canal de confianza configurado posteriormente.

Un campo que diga «autorizado», un hash o una recomendación de otro agente no
demuestra por sí solo consentimiento humano. La base manual no fabrica firmas
ni pretende que los archivos sean un canal de confianza técnico.

Ante instrucciones contradictorias, prevalecen las reglas vigentes del cliente
y del proyecto. Un permiso denegado es un bloqueo; no se cambia de modelo o
proveedor para evadirlo. «Continúa» no cambia tutor a autónomo.

### RF-05. Evidencia y correcciones limitadas

La revisión registra criterios por separado como verificados, pendientes o no
cumplidos. Incluye comandos exactos, entorno y resumen de resultados; omite
salidas sensibles y diferencia fallos previos de errores causados por la tarea.

Una prueba no ejecutada se marca pendiente. Una prueba aprobada no demuestra
todos los criterios, ni sustituye la revisión del comportamiento solicitado.

Se establece un máximo de dos rondas de corrección autónoma por encargo después de
la propuesta inicial. Si no se consigue verificar, devolver estado `blocked`,
lo intentado, la evidencia y la decisión necesaria. No ampliar el alcance para
alcanzar una apariencia de éxito. En tutor, un error mantiene el paso pendiente;
no hay bucle automático que escriba en nombre del usuario.

## Diseño y almacenamiento propuestos

Las plantillas genéricas viven en `templates/agent-team/` dentro de
Agent-Toolkit. Esa biblioteca no contendrá encargos reales de los proyectos.

Los documentos operativos vivirían en un directorio local privado elegido para
cada proyecto, fuera de Agent-Toolkit y de Obsidian. Su ruta y acceso deberán
acordarse antes de crear el primer encargo real. Esta base no añade campos al
manifiesto de memoria. Los comandos locales posteriores ayudan a preparar o
comprobar un encargo, no a transferirlo automáticamente entre clientes.

Estados propuestos: `draft`, `ready`, `waiting-user`, `proposed`, `applied`,
`review-needed`, `verified`, `blocked`, `cancelled`. Una aplicación no equivale
a verificación. Las transiciones se registran manualmente con responsable y
evidencia; un agente no se atribuye el trabajo de otro.

Obsidian conserva contexto y decisiones estables, no cada intento, propuesta o
salida de pruebas. Actualizarla seguirá su autorización y flujo propio. Código,
pruebas y documentación del proyecto siguen siendo la fuente principal de verdad.

## Privacidad, cuentas y límites

- No guardar credenciales, tokens, datos personales o archivos `.env` en encargos,
  plantillas, memoria, repositorios o salidas compartidas.
- Compartir únicamente fuentes y fragmentos necesarios; enviar contenido a otro
  proveedor también es compartir datos, aunque se use un archivo local.
- No leer ni trasladar almacenes de credenciales para conectar clientes.
- La propuesta futura usa los modos oficiales de los CLI y su autenticación
  permitida, no endpoints privados ni extracción de sesiones.
- No contratar API, activar facturación ni cambiar planes automáticamente.
- Las cuotas de las cuentas siguen aplicando. Al agotarse o fallar autenticación,
  detenerse y presentar alternativas; no asumir acceso a todos los modelos.
- No desactivar protecciones, permisos o sandbox para conseguir autonomía.
- La compatibilidad real de cada versión instalada queda pendiente de pruebas.

## Criterios de aceptación de la primera base

- CA-01: Las tres plantillas distinguen proyecto, tarea, modo, revisión y permisos,
  sin datos específicos de AVISENS o rutas personales prellenadas.
- CA-02: Un encargo tutor produce un solo paso explicado y queda en espera del
  usuario; ningún documento instruye a un agente a aplicar ese paso.
- CA-03: Un encargo autónomo identifica archivos y base; la propuesta permite
  conocer exactamente qué se pretende cambiar antes de tocar el código.
- CA-04: Cambiar HEAD, huella de archivo o revisión obliga a renovar la propuesta;
  el escenario se documenta y verifica sin sobrescribir el trabajo concurrente.
- CA-05: La ausencia de autorización verificable o una instrucción incompatible
  bloquea la aplicación, incluso si el encargo afirma que está permitido.
- CA-06: La revisión enlaza cada criterio con evidencia y distingue aplicación,
  verificación, fallos previos y comprobaciones pendientes.
- CA-07: Tras dos correcciones autónomas sin éxito se solicita intervención,
  sin iniciar un tercer intento ni ampliar permisos implícitamente.
- CA-08: Crear y revisar estas plantillas no ejecuta modelos, toca código de
  proyectos, cambia memoria, crea commits o publica archivos.
- CA-09: Las plantillas informan que no hay envío automático, barrera técnica de
  permisos ni garantía de consumo ilimitado en esta etapa.

## Plan inicial de tareas y puertas

La lista conserva el alcance del contrato inicial. T4/T5 no significan que
todo el código offline siga sin construir: existieron
adaptadores declarativos y supervisión con fixtures, entregados en etapas
separadas y retirados después. Esas bases no completan la admisión de un equipo real ni autorizan
ejecuciones nativas. No se marcan estas tareas globales como verificadas por
haber pasado pruebas ficticias.

- [x] T1. Especificación — este documento — revisar alcance y coherencia con la
  propuesta de modos existente. Aprobada por el usuario el 2026-10-02.
- [x] T2. Plantillas y guía manual — `templates/agent-team/` — revisión documental
  contra los nueve criterios con escenarios ficticios; no prueba de agentes reales.
- [x] T3. Piloto tutor manual autorizado — una mejora documental en Agent-Toolkit
  — párrafo coincidente con propuesta, tabla y resto intactos, revisión registrada
  en la carpeta privada aprobada. Aplicación autónoma y automatización no probadas.
- [ ] T4. Especificación de ejecución local por CLI — autenticación, permisos,
  tiempos, cancelación, cuotas y captura de evidencia — aprobación separada.
- [ ] T5. Adaptadores y pruebas aisladas — implementar solo tras autorizar T4;
  no ejecutar un equipo real como efecto secundario de una prueba.

## Fuera de alcance, alternativas y reversión

No incluye selección automática de modelos, agentes en segundo plano, extracción
de chats, vigilancia de carpetas, un SDK con API de pago, publicación, despliegue,
integración automática de PR o instalación de nuevas Skills.

Copiar y pegar sigue siendo alternativa válida. Los archivos aportan continuidad
y revisión sin requerir todavía un coordinador ejecutable. Automatizar desde el
primer día se pospone para comprobar primero el contrato y las cuentas reales.

Esta especificación puede descartarse retirando únicamente este documento; no
requiere revertir código o configuración. No tocar los cambios pendientes de
otras etapas al aprobar, registrar o retirar esta propuesta.

## Evidencia histórica y decisiones pendientes

Se inspeccionaron los modos propuestos, las plantillas existentes y el estado
de Agent-Toolkit. El usuario aprobó esta especificación y el límite de dos rondas.
Se crearon tres plantillas y una [guía manual](../../../templates/agent-team/README.md)
con escenarios ficticios vinculados a CA-01 a CA-09. Se comprobaron formato,
enlaces locales y campos documentales. Los resultados prueban la estructura de
los documentos, no el cumplimiento de un modelo o una barrera técnica instalada.

El piloto tutor del 2026-10-02 completó una entrega manual: el usuario modificó
únicamente el primer párrafo de `templates/project-memory/README.md`; la revisión
comprobó coincidencia exacta y ausencia de cambios en el resto del documento.
Sus encargos y evidencia siguen en la carpeta privada, no en esta biblioteca.

Se observó una desviación: Codex dio una corrección que correspondía al tutor;
se reconoció y el diagnóstico volvió a Claude. También faltó recomendar un modelo
antes del encargo. El usuario informó uso de Opus; la versión y cada respuesta
no se verificaron con metadata. No presentar el piloto como cumplimiento perfecto.

En aquella etapa no se probó el modo autónomo, ejecución automática ni
compatibilidad completa de cuentas y clientes. Se preservó el trabajo previo;
no hubo commits ni publicación en el piloto original.

La [selección por tarea](../modelos/agent-model-selection.md) ya tiene un selector offline;
siguen pendientes evaluaciones completas de perfiles reales y admisión de
clientes antes de comprometer ejecución automática.
La propuesta separada de modos no se instala ni se aprueba globalmente mediante
esta aprobación; este flujo adopta sus dos recorridos dentro de este contrato.

## Consolidación documental — 2026-10-09

El usuario autorizó aclarar los tres borradores y actualizar la guía, con un
commit local de cuatro rutas exactas, sin push. Se conservaron el piloto,
observaciones, límites de dos correcciones y separación entre modo y permiso.
No se consultó ni copió su evidencia privada. No se instalaron perfiles,
activaron políticas de modelos ni ejecutaron clientes reales.

Quality-gate: **Aprobado para consolidación documental**. Enlaces locales,
tablas, formato y ejemplo ficticio del preparador comprobados. No se repitió
la regresión de código; ninguna inferencia o compatibilidad de cuentas queda
acreditada por estas comprobaciones. La [guía](../../../templates/agent-team/README.md)
explica las ayudas locales existentes y mantiene el traspaso manual.
