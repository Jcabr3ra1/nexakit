# Encargos compartidos para tu equipo de agentes

Esta base organiza el trabajo entre Codex y Claude mediante archivos.
Tú decides cuándo pasar al siguiente agente. No es un ejecutor, un servicio
de API ni una conexión automática entre tus chats.

Contrato documental: [equipo mediante archivos compartidos](../../docs/agentes/coordinacion/agent-team-handoffs.md),
consolidado junto con esta guía. El historial del piloto permanece separado.
Adaptación aprobada: [modelos en los traspasos](../../docs/agentes/coordinacion/agent-team-model-handoff.md).
Las reglas del proyecto y los permisos de cada cliente siguen mandando.

## Las tres plantillas

| Archivo | Quién lo prepara | Para qué sirve |
| --- | --- | --- |
| [01-encargo.md](01-encargo.md) | Codex | Define objetivo, contexto mínimo, modo y permisos |
| [02-propuesta.md](02-propuesta.md) | Claude | Explica un paso o propone los cambios exactos |
| [03-revision.md](03-revision.md) | Escritor y después Codex | Separa resultados declarados de evidencia revisada |

No rellenes las plantillas originales con datos de un proyecto. Para una tarea
real se copian a una carpeta local privada acordada, fuera de esta biblioteca
y de Obsidian. Las plantillas no crean ni configuran esa carpeta. El piloto tutor
anterior conserva sus documentos históricos, sin esta adaptación retrospectiva.

Una estructura posible, todavía sin instalar:

```text
<carpeta-privada>/<projectId>/<taskId>/
  r01/
    01-encargo.md
    02-propuesta.md
    03-revision.md
  r02/  # si hay una corrección o cambio de modo, conservando r01
```

Las rutas concretas se acuerdan para cada trabajo. No meter esta carpeta en GitHub,
la bóveda, una carpeta sincronizada o un repositorio público por defecto.

## Ayudas locales disponibles

Las plantillas se completan a mano: no hay un preparador ni un verificador
automáticos. Para pedir una revisión por otras IA existe la
[fábrica](../../docs/agentes/coordinacion/fabrica.md), que no sustituye el permiso
del receptor ni la revisión humana del encargo.

## Modelo recomendado y modelo observado

El [selector local](../../docs/agentes/modelos/agent-model-selector.md) recomienda a partir de
solicitud, catálogo y política; no guarda informes, ejecuta IA o cambia el CLI.
Estas plantillas tampoco lo invocan automáticamente. Su bloque se completa
manualmente y la persona la revisa; no deja listo un encargo bajo esta política
por el simple hecho de haberla rellenado.

1. El coordinador obtiene una decisión para el participante y rol realmente
   encargados, con datos de confianza y acceso declarado. Si faltan datos, no
   inventa modelos, presupuestos ni disponibilidad de la cuenta.
2. Resume en `01-encargo.md` identidad, perfil, modelo solicitado, esfuerzo,
   versiones, huellas, motivos y restricciones. Un informe guardado en carpeta
   privada requiere permiso delimitado; no copiar todo su inventario a la biblioteca.
3. Solo `recommended` completo, vigente y revisado permite `ready` bajo esta
   política. `pending`, `needs-info`, `blocked` o `invalid` no se vuelven válidos
   por copiarse. El usuario elige el modelo manualmente en su cliente.
4. El proponente conserva la selección recibida y la evidencia que exista en
   `02-propuesta.md`. Si aún no hay metadata de la respuesta, deja `unknown`;
   no adivina la versión ni rellena luego el pasado para simular certeza.
5. La sección A de `03-revision.md` registra al escritor: humano en tutor,
   ejecutor autorizado en autónomo. B contrasta por separado proponente, ejecutor
   cuando corresponda y revisor; cada rol usa su decisión, no un modelo global.

`requestedModel` es lo pedido. `observedModels` es lo observado con procedencia;
`verification` distingue `verified`, `reported` y `unknown`. Evidencia del cliente
de la ejecución concreta, contrastada en revisión, permite `verified`; declaración
del usuario o estado de sesión queda `reported`. Un agente que diga su modelo,
la selección o el catálogo no certifican qué respondió. No inferir un principal
cuando alias/auxiliares sean ambiguos.

El código y el modelo se revisan separadamente. En tutor un paso correcto puede
verificarse manualmente con modelo desconocido declarado como observación; no
habilita escritura automática. Metadata ausente/modelo no permitido requiere
resolución humana antes de aplicación estricta automática futura. No hay retries
para «comprobar» gastando cuota ni fallback al default, `latest`, otro proveedor
o API de pago. Si el cliente no puede pedir/observar el perfil, indicar el límite.

`audit.*Sha256` identifica JSON canónico, mientras `decisionFileSha256` identifica
bytes del informe guardado. No son intercambiables ni firmas de autorización.
Conservar consumo y rondas entre modelos, roles y revisiones; una decisión nueva
no pone a cero el historial. Las cuotas de cuentas siguen aplicando.

## Cómo funcionaría en tutor

1. Codex rellena el encargo para un único paso y deja la escritura al usuario.
2. Indicas a Claude que lea la ruta exacta del encargo y guarde su explicación
   en la propuesta de esa revisión. Le autorizas solo esa escritura documental.
3. Claude explica objetivo, ubicación, código y comprobación; espera.
4. Tú escribes el código. A Codex le dices «revisa este paso» y le das la ruta
   de la entrega o el resultado que no pueda consultar.
5. Codex revisa código y evidencia, documenta la conclusión y permite el siguiente
   paso solo cuando esté correcto. Ningún agente aplica código en este modo.

Una salida de prueba enviada por ti puede ser evidencia revisada, pero no se
presenta como una ejecución independiente del coordinador. Si las instrucciones
del proyecto piden primero pistas, Claude debe respetarlas antes de dar la solución.

## Cómo funcionaría en autónomo

1. Tú autorizas una implementación concreta y el contexto que puede compartirse.
   Codex prepara el encargo; Claude propone sin modificar código funcional.
2. Indicas a Claude qué propuesta aplicar y le das autorización directa para
   escribir las rutas de ese encargo y ejecutar las pruebas delimitadas. La autorización
   cubre el trabajo acordado, no hay que repetirla para cada archivo.
3. Claude compara revisión, documentos, rama, HEAD y huellas antes de escribir.
   Si coinciden y los permisos son válidos, aplica y registra sus resultados.
4. Codex inspecciona el diff y la evidencia real. Si hace falta, prepara una
   corrección para Claude, conservando las entregas anteriores.
5. Hay hasta dos rondas de corrección después de la primera propuesta. Si ambas
   fallan, el equipo se detiene y explica qué decisión o evidencia falta.

Commit, push, PR, memoria, gastos y despliegues no se incluyen por defecto.
Una aplicación parcial se informa; no implica rollback automático ni éxito.
Ningún agente evadirá permisos cambiando de proveedor.

## Identidad y vigencia sin tecnicismos innecesarios

- `projectId` identifica el proyecto; `taskId`, el trabajo concreto.
- `revision` identifica el encargo vigente; una corrección conserva el historial.
- `HEAD` identifica el último commit, no todos los cambios locales.
- `SHA-256` es una huella del contenido: ayuda a detectar si un archivo cambió.
  No demuestra quién autorizó su aplicación ni que la propuesta sea correcta.
- `correctionRound` cuenta correcciones autónomas; cambiar de revisión no lo reinicia.

Cada receptor confirma su propia autorización en la sesión. Un documento que
afirme «permiso concedido» no la sustituye. En esta etapa las comprobaciones son
manuales y las plantillas no imponen un bloqueo técnico a las herramientas.

## Revisión documental con escenarios ficticios

Los siguientes casos usan un proyecto imaginario `demo-counter`, tarea
`counter-step`, rama `demo/counter` y ruta `src/counter.js`. No se crearon esos
archivos, ni se ejecutaron agentes o pruebas del proyecto ficticio.

| Criterio | Escenario y resultado esperado | Campo o regla revisada |
| --- | --- | --- |
| CA-01 | Copiar las tres plantillas: ninguna trae datos reales; las identidades y permisos se completan por tarea | Identidad y autorización en los tres documentos |
| CA-02 | Encargo tutor para explicar un contador: Claude entrega un paso y espera; ningún agente lo aplica | Sección Tutor y `waiting-user` en propuesta |
| CA-03 | Encargo autónomo para ese contador: se declara ruta, base y cambio preciso antes de escribir | Base del encargo y tabla de cambios de propuesta |
| CA-04 | El archivo cambia después de proponer o el encargo pasa de r01 a r02: el ejecutor bloquea la entrega r01 | Comparación de HEAD, huellas y documentos antes de aplicación |
| CA-05 | El archivo dice «autorizado» pero Claude no recibió permiso directo para aplicar, o el proyecto exige tutor: no aplica | Autorización verificable y jerarquía de instrucciones |
| CA-06 | Una prueba pasa pero falta verificar un criterio: aplicación registrada, conclusión pendiente | Secciones A y B de revisión separadas por procedencia |
| CA-07 | Fallan las correcciones 1 y 2: `blocked`, sin ronda 3 ni contador reiniciado | Límite del encargo y sección C de revisión |
| CA-08 | Crear las plantillas solo añade documentación: sin llamadas a CLI de agentes, código de proyecto, Git mutante o memoria | Alcance documental de esta entrega y estado local inspeccionado |
| CA-09 | Se entrega un archivo a Claude: no se supone envío automático, permiso técnico ni cuota ilimitada | Advertencias explícitas en plantillas y guía |

Escenarios adicionales revisados:

- **Tutor a autónomo:** hace falta una instrucción explícita válida; un encargo
  nuevo inspecciona lo ya escrito y conserva el progreso. «Listo» no hace el cambio.
- **Autónomo a tutor:** detener al escritor de forma segura, registrar cualquier
  aplicación parcial y comenzar desde el paso pendiente; no borrar lo aplicado.
- **Prueba no ejecutada:** marcar pendiente, no inventar aprobación.
- **Archivo nuevo ya existente:** renovar propuesta; no reemplazarlo a ciegas.
- **Secreto en contexto o prueba:** excluirlo del traspaso y pedir evidencia
  segura; no divulgarlo como parte de un diff o una salida.
- **Cuota o autenticación fallida:** detenerse, no activar consumo API de pago.

Esta revisión comprueba cobertura documental, no comportamiento real de los
modelos. El piloto tutor previo comprobó solo su recorrido manual; aplicación
autónoma y selección de modelos reales siguen sin probarse.

## Escenarios de la adaptación de modelos

Revisión documental con `demo-counter` y perfiles inventados `demo-light` y
`demo-balanced`; no se crearon entregas reales ni se consumió cuota. Los IDs
MS-CA corresponden a CA-01 a CA-09 de la especificación de esta adaptación.

| ID | Escenario contrastado | Regla que conserva la plantilla |
| --- | --- | --- |
| MS-CA-01 | Tutor recibe una decisión; autónomo usa decisiones distintas para proponente, ejecutor y revisor | Identidad/rol en selección, propuesta y revisión B; sin ejecutor escritor en tutor |
| MS-CA-02 | Hay metadata específica, una declaración o ningún dato | `verified` con contraste; `reported` con declaración/estado; `unknown` sin evidencia |
| MS-CA-03 | El usuario escribe el paso y Claude tiene otro perfil disponible | Tutor mantiene un paso y escritor humano; disponibilidad no autoriza aplicación |
| MS-CA-04 | El informe dice `recommended`, pero no hay autorización propia | Autorización sigue siendo independiente; no se configura ni ejecuta el CLI |
| MS-CA-05 | El alias cambia, aparecen auxiliares o falta metadata | Registrar discrepancia/limitación y revisión humana; sin retry ni aplicación estricta automática |
| MS-CA-06 | Estado `pending`, `needs-info`, `blocked`, `invalid` o `recommended` | Solo el último completo/vigente/revisado deja `ready`; no usar defaults |
| MS-CA-07 | JSON con espacios distintos o encargo de otra revisión | Hash canónico distinto de bytes; identidad/revisión se contrasta antes de consumir |
| MS-CA-08 | Dos correcciones agotadas y un perfil nuevo | Conservar rondas/consumo; no ronda 3, más permisos o cambio de proveedor |
| MS-CA-09 | Copiar plantillas nuevas al lado de un piloto antiguo | Biblioteca genérica; sin rellenar modelos del pasado, tocar clientes o reescribir piloto |

Un paso tutor puede quedar verificado en código y desconocido en modelo: ambos
resultados se registran sin atribuir el código del usuario a una IA. Esta tabla
no demuestra cumplimiento de agentes reales ni instala barreras técnicas.

## Qué falta y qué ya se puede utilizar

Las plantillas pueden apoyar entregas manuales delimitadas. Sus datos ficticios no sirven como política
real de modelos. Cuando exista inventario y evaluación aprobados, un traspaso
nuevo conservará sus propios permisos y evidencia; no se repite ni altera el
piloto histórico para rellenar datos faltantes.

La ejecución automática de clientes reales sigue sin admisión: necesita evidencia,
permisos y pruebas separados. Los comandos locales existentes no la habilitan ni
garantizan consumo ilimitado. Esta actualización documental del 2026-10-09 no
instala perfiles, cambia modelos activos o activa autonomía global.
