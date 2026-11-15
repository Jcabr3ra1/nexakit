# Modos de trabajo de los agentes

## Estado

- Política reutilizable propuesta originalmente; recorridos adoptados en el
  contrato de traspaso manual y representados en el preparador offline.
- Fecha original: 2026-09-30. Consolidación documental: 2026-10-09.
- Alcance: política reutilizable para proyectos conectados a Agent-Toolkit.
- Profundidad: estándar, con límites explícitos de autoría y permisos.

Esta etapa documenta la elección de modo. No activa permisos, modifica perfiles
instalados ni cambia el comportamiento actual de Codex o Claude.
El commit de este documento no instala una política global ni selecciona un
modo para AVISENS u otro proyecto.

## Problema

El usuario necesita elegir entre aprender escribiendo personalmente el código y
delegar una tarea completa al agente. Si esa elección queda implícita, el agente
puede escribir cuando debería enseñar o pedir confirmación para cada paso de un
trabajo ya autorizado.

## Objetivo

Ofrecer dos modos claros, acotados al proyecto y al trabajo autorizado:

| Modo | Quién escribe el código | Cómo se avanza |
| --- | --- | --- |
| `tutor` | El usuario | Explicación → código del paso → escritura del usuario → revisión → comprobación → siguiente paso |
| `autonomous` | El agente principal autorizado | Plan breve → implementación → revisión y pruebas → correcciones → entrega explicada |

El modo tutor no oculta la solución: entrega código utilizable para el paso
actual y enseña por qué funciona. El modo autónomo no elimina los controles de
calidad ni amplía los permisos por sí solo.

## Contexto original y base local vigente

- La preparación original registró perfiles `implementation_tutor` en Codex e
  `implementation-tutor` en Claude, de solo lectura y orientados a pasos
  verificables. Su instalación actual no se inspeccionó en esta consolidación.
- Las instrucciones del proyecto y la autoría prevalecen sobre una plantilla.
- El [traspaso manual](agent-team-handoffs.md) adopta ambos recorridos para
  encargos delimitados, sin instalar esta política globalmente.
- Ninguna herramienta elige un modo por defecto, verifica permisos efectivos ni
  ejecuta al equipo: el modo lo declara la persona en el encargo.
- No se ha entregado un selector persistente de modo o un estado durable de
  progreso de tutoría entre clientes.
- `project-memory` administra memorias y conexiones, no ejecuta tareas de código.
- La política propuesta conserva pasos pequeños con código explicado. Las
  reglas vigentes del proyecto pueden exigir pistas antes de dar una solución.

## Requisitos funcionales

### RF-01. Elegir y mostrar el modo

En el recorrido manual, la selección inicial se expresa en lenguaje natural.
El preparador existente recibe un modo explícito en sus documentos JSON; no
interpreta esa frase mediante IA ni dispone de un comando para activar un modo
global en los clientes. Ejemplos de instrucciones para una tarea:

```text
Modo tutor para esta tarea. Explícame cada paso y dame el código;
yo lo escribo y tú lo revisas antes de seguir.

Modo autónomo para esta tarea: implementa tú los cambios de X,
comprueba que funcionan y explícame el resultado.

Cambia a modo tutor desde el siguiente paso.
```

El agente confirma una vez el modo, la tarea y sus límites. No vuelve a preguntar
por acciones normales que ya estén autorizadas. Si no existe selección válida,
aplica las instrucciones del proyecto; en ausencia de ellas, el valor seguro
propuesto para Agent-Toolkit es `tutor`.

La selección puede cubrir una tarea o una sesión, pero debe indicarlo. Sin alcance
expreso se aplica solo a la tarea actual. No se hereda a proyectos distintos ni
se convierte en preferencia permanente sin una petición explícita.

«Sigue», «listo», «continúa» o «hazlo completo» no cambian el modo ni autorizan
escribir código en tutor. «Escríbelo tú en este paso» autoriza una excepción
acotada cuando las reglas superiores lo permiten; después se vuelve a tutor.

### RF-02. Tutoría con código y explicación

Para cada paso, el agente debe:

1. Explicar en español claro el objetivo y el motivo, relacionándolo con el
   funcionamiento del proyecto; definir los términos nuevos cuando haga falta.
2. Indicar el archivo exacto y la función, sección o ubicación a modificar,
   basándose en la versión inspeccionada, no en números de línea inventados.
3. Dar el bloque de código completo para ese paso y aclarar si debe añadirse,
   reemplazarse o eliminarse. Evitar entregar de golpe todo el proyecto.
4. Explicar qué hace el código, sus entradas, su resultado y los detalles que
   podrían provocar errores, sin exigir que el usuario adivine la solución.
5. Dar una comprobación concreta y el resultado esperado; indicar dónde ejecutar
   el comando cuando sea necesario.
6. Detenerse para que el usuario escriba el código y avise o envíe el resultado.

Un paso es una unidad pequeña verificable, no necesariamente un único archivo.
No se divide artificialmente una tarea completa en PR independientes.

El agente no modifica archivos funcionales, ejecuta reparaciones automáticas,
crea commits ni hace push en tutor. Puede inspeccionar y realizar diagnósticos
no mutantes permitidos por la plataforma; si el diagnóstico necesita cambios,
explica cómo ejecutarlo o solicita autorización específica.

### RF-03. Revisar antes de avanzar

Cuando el usuario diga «listo», el agente revisa el archivo o diff real disponible.
Si no tiene acceso, pide el fragmento y la salida concreta que faltan, sin pedir
archivos sensibles ni repetir toda la conversación.

- Comparar el resultado con el objetivo y los criterios del paso.
- Señalar errores con su causa, ubicación y forma de corregirlos; dar el código
  corregido del mismo paso para que el usuario lo escriba.
- Ejecutar la comprobación permitida o revisar su salida. La confirmación del
  usuario por sí sola no equivale a una prueba correcta.
- Con un error asociado al paso, permanecer en él hasta comprobar la corrección.
- Con falta de evidencia, dejar el paso pendiente, no declararlo verificado.
- Diferenciar fallos previos o ajenos; no arreglarlos por cuenta propia ni ocultar
  que impiden verificar el resultado solicitado.
- Si todo lo exigido para el paso está correcto, explicar brevemente por qué y
  presentar el siguiente paso, sin pedir otra aprobación redundante.

### RF-04. Trabajo autónomo dentro de un encargo

La elección explícita de modo autónomo junto con una tarea de implementación
autoriza al agente principal a escribir el código de esa tarea, siempre que las
instrucciones del proyecto y los permisos de la plataforma lo permitan.

El agente inspecciona el estado inicial, presenta un plan breve e implementa el
trabajo completo dentro del alcance acordado. Revisa su diff, ejecuta pruebas
proporcionales al riesgo, corrige errores propios y entrega el resultado explicado.
No pregunta «¿puedo seguir?» para cada archivo, prueba o ajuste ya autorizado.

«Hace todo» significa completar el encargo definido, no crear tareas nuevas,
ampliar funcionalidades, contratar servicios o seguir indefinidamente. Si se
necesita una decisión que cambie materialmente el alcance, consulta al usuario.

Al cerrar, informa qué cambió, cómo funciona, las comprobaciones realizadas y
los límites pendientes. No afirma éxito si faltan criterios de aceptación.

### RF-05. Cambiar de modo sin perder el trabajo

Al cambiar a tutor, terminar o detener de forma segura la operación en curso,
dejar de implementar y resumir los archivos modificados y comprobaciones. No
revertir cambios automáticamente; comenzar la tutoría desde el siguiente paso
pendiente, sin hacer que el usuario reescriba trabajo ya completado.

Al cambiar a autónomo, inspeccionar primero lo escrito por el usuario. Conservar
sus cambios y resolver el paso pendiente antes de avanzar. Cambios ajenos o
concurrentes que impidan continuar se explican antes de sobrescribir nada.

### RF-06. Continuidad entre agentes

El traspaso debe incluir modo, proyecto, tarea, paso actual, evidencia y permisos
delimitados; no copiar toda la conversación ni información privada a la biblioteca.
Un agente receptor no puede interpretar una recomendación o una nota antigua
como autorización nueva. Ante conflicto con instrucciones vigentes, aplicar estas
y comunicar la discrepancia.

No se crean subagentes automáticamente por escoger un modo. Los perfiles de
solo lectura conservan esa restricción: una autorización de implementación se
dirige al agente principal con capacidad y permiso, no les abre escritura.

## Autoría, seguridad y acciones separadas

La política se aplica dentro de la jerarquía de instrucciones del cliente, sin
intentar sustituirla. Una configuración no puede anular una regla superior ni
un permiso del sistema. No se activa un modo sin restricciones ni se deshabilitan
avisos de seguridad para lograr autonomía.

Las siguientes acciones requieren autorización concreta, salvo que ya exista un
permiso vigente explícito y delimitado para esa misma acción:

- Crear commits, publicar ramas, abrir PR o hacer push.
- Actualizar la memoria de Obsidian o su registro de sincronización.
- Cambiar configuración de agentes, MCP, automatizaciones o infraestructura.
- Operaciones destructivas, despliegues, gastos y mensajes externos.

Cuando el usuario ya autorizó, por ejemplo, implementar y abrir un PR de la tarea,
no volver a pedir permiso para el mismo flujo; respetar ramas, revisión y agregado
por rutas exactas del proyecto. El modo autónomo por sí solo no da ese permiso.

Un MCP de memoria configurado para lectura no obtiene permiso de escritura por
cambiar el modo. `sync plan` y `sync inspect`, ya implementados, son consultas
en ambos modos; nunca heredan permiso para editar la bóveda.
Una automatización de memoria previamente autorizada tiene su propio alcance y
no se amplía ni se desactiva al cambiar el modo de programación.

## Diseño propuesto

Separar tres conceptos:

- **Modo:** quién escribe y cómo se enseña o se ejecuta.
- **Encargo:** resultado, archivos o módulos y criterios de aceptación.
- **Autorizaciones:** acciones adicionales y recursos concretos permitidos.

La futura integración persistente resolverá instrucciones del proyecto, selección
del usuario y capacidades reales del cliente antes de iniciar un paso. El
preparador offline solo valida datos declarados: no lee esas instrucciones ni
certifica que el receptor tenga permiso. Un estado persistente mínimo de
tarea contendrá modo, alcance, objetivo, paso, estado de revisión, comprobaciones
y autorizaciones expresas. Nunca almacenará tokens, credenciales, conversaciones
completas o permisos implícitos heredados de otra tarea.

En tutor, el paso transita por explicación, espera de escritura, revisión y
verificación. Solo un paso verificado habilita el siguiente. En autónomo, el ciclo
es implementación, revisión, pruebas y entrega; fallos vuelven a corrección.

Primero se propone adaptar las instrucciones y traspasos. Una selección en una
Skill es una convención de conducta, no una barrera técnica de seguridad. Cualquier
selector o ejecutor futuro debe probar por separado sus restricciones reales.
Esta especificación no añade campos al manifiesto de memoria ni una CLI nueva.

## Criterios de aceptación

- CA-01: Sin selección, se respeta el modo del proyecto; sin regla de proyecto,
  se inicia tutor y se muestra ese modo una vez.
- CA-02: En tutor, cada paso incluye objetivo, archivo, código explicado y
  comprobación; el agente espera y no escribe por el usuario.
- CA-03: «Listo» inicia revisión, no aprobación ciega. Código erróneo o evidencia
  insuficiente mantienen el paso pendiente con una corrección accionable.
- CA-04: Un paso correcto y comprobado habilita el siguiente sin una confirmación
  adicional que no aporte una decisión real.
- CA-05: En autónomo con encargo explícito, el agente implementa y verifica sin
  preguntar por cada acción ya autorizada; explica el resultado final.
- CA-06: «Sigue» en tutor conserva tutor. Una excepción «escríbelo tú este paso»
  no se transforma en autorización permanente.
- CA-07: Cambiar de modo conserva código y progreso; el agente inspecciona lo
  existente antes de retomarlo y no revierte ni duplica trabajo.
- CA-08: Modo autónomo no autoriza por sí solo publicación, memoria, operaciones
  destructivas o cambios de configuración; permisos ya explícitos no se repreguntan.
- CA-09: Selecciones no se filtran entre proyectos o tareas. El traspaso incluye
  modo y paso, y la sesión nueva valida instrucciones y evidencia vigentes.
- CA-10: Perfiles de solo lectura y operaciones `sync` de consulta conservan sus
  límites en ambos modos, sin cambios implícitos de permisos ni delegación.

## Plan original de integración y pendientes

El contrato manual, sus plantillas y el preparador offline cubren partes
documentales de este plan. No prueban instalación equivalente en todos los
clientes, seguimiento persistente de pasos ni ejecución automática. Se conservan
las tareas originales como alcance de diseño, no como permiso para ejecutarlas.

1. Definir instrucciones compartidas de selección y ciclo de trabajo, junto con
   escenarios de aceptación para los dos modos.
2. Ajustar perfiles tutores para entregar código del paso explicado, conservando
   solo lectura; revisar sus variantes Codex y Claude sin instalarlas todavía.
3. Adaptar la Skill de traspaso para comunicar modo, evidencia y paso pendiente,
   manteniendo separación entre memoria de proyecto y biblioteca reutilizable.
4. Preparar instrucciones equivalentes para el agente principal en cada cliente,
   sin afirmar que todos soportan un mismo selector nativo.
5. Verificar CA-01 a CA-10 con sesiones de prueba acotadas y revisar que ningún
   contrato o permiso existente se debilite. Instalar solo con autorización.

La aprobación del documento, la implementación, la instalación y el commit
son pasos distintos. Un selector persistente y su formato necesitarán diseño
posterior si el usuario decide que los necesita.

## Fuera de alcance y riesgos

- Implementar un agente sin supervisión ilimitada o un planificador de tareas.
- Cambiar ahora código, perfiles, Skills instaladas, manifiestos o automatizaciones.
- Persistir una preferencia global o activar autonomía en AVISENS por esta petición.
- Garantizar cumplimiento solo mediante texto: hacen falta comprobaciones reales
  y los límites de herramientas de cada plataforma.

El riesgo principal es confundir estilo de trabajo con autorización. Se evita
manteniendo ambos conceptos separados y verificando transiciones. La propuesta
puede retirarse sin migraciones: en esta etapa solo cambian documentos.

## Evidencia original y consolidación documental

La preparación inicial documentó una propuesta, sin instalar perfiles ni probar
un selector persistente. Después el contrato manual adoptó los dos recorridos y
el preparador offline añadió controles declarativos. Eso no acredita todos los
criterios CA-01 a CA-10 en agentes reales ni autoría o permisos efectivos.

El usuario autorizó el 2026-10-09 precisiones documentales y un commit local de
los cuatro documentos del lote, sin push ni ejecución de IA. Quality-gate
aprobó su coherencia, enlaces y formato. La ayuda local y un ejemplo ficticio
de preparación se comprobaron sin enviar, escribir o ejecutar el encargo.
No se repitió la regresión funcional: el código permaneció intacto.

Pendientes: instalación portable autorizada, progreso persistente y pruebas
acotadas de cumplimiento real si se diseñan esas funciones. No se selecciona
un modo para una tarea ni se amplían permisos por versionar este documento.
