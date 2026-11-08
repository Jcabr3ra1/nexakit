# Revisión cruzada entre sesiones de Claude y Codex

Este modo conecta las sesiones que ya tienes abiertas en tus terminales. Puedes
empezar con cualquiera, publicar el contexto de una tarea y pedir una revisión
del otro sin copiar sus respuestas entre ventanas. Los encargos y los informes
se comparten mediante el MCP local de Agent Toolkit.

El MCP no inicia una CLI, no llama a una API y no despierta ventanas inactivas.
El trabajo lo realiza el agente receptor en su sesión visible, cuando atiende
su bandeja. Cada encargo requiere una vista previa nueva y aprobación humana,
salvo en el [modo automático](#modo-automático), que se autoriza una vez por
colaboración.
Las sesiones siguen consumiendo sus modelos según la configuración de cada
cliente; el intercambio no hace gratuitas esas sesiones ni verifica sus cuotas.

## Conectar ambos clientes una vez

Usa el mismo checkout de Agent Toolkit y el mismo directorio de tareas en ambos
clientes. Sustituye `/ruta/Agent-Toolkit` por su ruta absoluta. Esa instalación
puede atender distintos proyectos; no se copia Agent Toolkit dentro de ellos.

Si ya registraste el servidor en un cliente, reutiliza su conexión en lugar de
añadir otra con el mismo nombre. Estos comandos registran el servidor que falte:

```sh
codex mcp add agent-toolkit -- node /ruta/Agent-Toolkit/bin/agent-toolkit-mcp.js
claude mcp add --scope user --transport stdio agent-toolkit -- node /ruta/Agent-Toolkit/bin/agent-toolkit-mcp.js
```

Reinicia o reconecta los clientes para cargar las herramientas nuevas y comprueba
que ambos ofrecen `start_collaboration` y `wait_for_peer_handoff`. No hace falta
iniciar una llamada a otro modelo para comprobar el registro.

Por defecto ambos usan `~/.agent-toolkit/workflows/peers/`. Si configuras
`AGENT_TOOLKIT_WORKFLOW_DIR`, debe tener el mismo valor en los dos servidores.
Por ejemplo, al registrarlos se puede añadir `--env
AGENT_TOOLKIT_WORKFLOW_DIR=/ruta/privada/workflows` en Codex y `--env
AGENT_TOOLKIT_WORKFLOW_DIR=/ruta/privada/workflows` en Claude, antes de `--`.
Usa un directorio propio; la carpeta `peers` y sus registros deben ser privados.
Configurar otra raíz de almacenamiento crea una bandeja independiente.

Cada encargo necesita una confirmación del usuario fuera del modelo:

- **Codex** declara el diálogo de confirmación de MCP (elicitation): al aprobar
  aparece un diálogo con el prompt completo. Si se cancela, no se envía.
- **Claude Code 2.1.310** no muestra ese diálogo. Si la petición falla por
  cualquier motivo, `approve_peer_review` usa el aviso de permiso del propio
  cliente, registra la aprobación como `method: "permiso-cliente"` y escribe
  en el registro del MCP el código del fallo. Esa confirmación solo existe si
  Claude Code pregunta por la herramienta: en modo automático hay que añadir
  `mcp__agent-toolkit-workflow__approve_peer_review` a `permissions.ask` de
  `~/.claude/settings.json`. El MCP no puede comprobarlo.
- El modo automático (`autoReviews`) exige el diálogo: sin él, la colaboración
  automática no se crea.

Comprobado el 2026-10-26: los primeros encargos enviados desde Claude Code
fallaron con un error genérico al pedir el diálogo, y en modo automático la
herramienta se ejecutó sin aviso de permiso.

## Empezar mañana en otro proyecto

Abre Claude y Codex en el mismo repositorio. En la sesión que llevará el trabajo,
puedes pedir:

> Usa Agent Toolkit para crear una colaboración de este repositorio. Yo trabajaré
> contigo como agente principal. Publica el objetivo, alcance y contexto; pide
> revisión al otro agente cuando te lo indique. Muéstrame cada encargo completo
> y espera mi aprobación antes de enviarlo.

El agente llama `start_collaboration` con `projectRoot`, `project`, `title`,
`objective`, `primaryAgent` (`claude` o `codex`) y el contexto inicial. El MCP
devuelve un `taskId`. La etiqueta `project` no sustituye la ruta: cada operación
comprueba la raíz real y la identidad del directorio.

En la otra terminal pide:

> Usa Agent Toolkit para consultar las colaboraciones abiertas en este
> repositorio con get_collaboration. Si hay varias, muéstramelas para elegir.
> Atiende la tarea seleccionada con wait_for_peer_handoff. Reclama únicamente
> encargos dirigidos a ti, revisa los archivos aprobados sin editar ni ejecutar
> pruebas, muestra tus acciones aquí y entrega tu informe con submit_peer_review.
> No envíes otro encargo ni apruebes nada por tu cuenta.

`get_collaboration` sin `taskId` lista las tareas abiertas de esa raíz. Con
`taskId` devuelve el contexto, los encargos y los informes. Así puedes localizar
la tarea desde la otra sesión sin copiar su contenido. No se elige una tarea
automáticamente cuando hay varias.

Las respuestas de las herramientas son compactas para no llenar el contexto del
modelo: una colaboración llega a decenas de KB (cada prompt, huella e informe) y
repetirla en cada llamada cuesta tokens. `start_collaboration`,
`publish_peer_context` y `close_collaboration` devuelven un resumen (`id`,
`revision`, `state`, `reviewCount`). `approve_peer_review`, `request_peer_review`
y `wait_for_peer_handoff` devuelven el encargo sin el prompt ni las huellas
(`files` y `snapshotSha256`), y `submit_peer_review` no repite el informe.
`claim_peer_review` entrega el prompt una sola vez, al revisor. `get_collaboration`
omite el historial y los prompts, y deja de incluir el texto de los informes ya
verificados (con resultado registrado); `completo: true` devuelve el registro
entero.

Las esperas duran 15 segundos por defecto y hasta 60 con `waitMs`. Sin `taskId`,
`wait_for_peer_handoff` atiende todas las colaboraciones abiertas de esa raíz y
devuelve el `taskId` del encargo recibido. Cada espera solo lee la bandeja. El agente
puede continuar esperando si le pediste expresamente atenderla; no hay un bucle
de modelos iniciado por el servidor. Puedes indicar un tiempo de atención o
interrumpir la sesión. Una terminal abierta pero que no está atendiendo no
recibe el encargo en su conversación hasta que lo consulte.

## Modo automático

Para no aprobar cada encargo, crea la colaboración con `autoReviews` (de 1 a 8).
El cliente pide una sola confirmación interactiva; después el agente principal
envía encargos con `request_peer_review`, sin vista previa, hasta ese cupo. Los
encargos cancelados o desactualizados también consumen cupo.

- Solo `primaryAgent` envía automáticamente. El revisor no puede responder con
  otro encargo automático, lo que evita cadenas entre agentes.
- Sigue habiendo un único encargo activo por tarea y las mismas huellas,
  reclamaciones y comprobaciones de vigencia.
- Al agotar el cupo, `request_peer_review` falla y el flujo con
  `preview_peer_review` y aprobación manual sigue disponible.
- Sin confirmación interactiva o si el usuario la rechaza, la colaboración no se
  crea.

## Modelo y esfuerzo recomendados

`preview_peer_review` y `request_peer_review` aceptan `reviewer` con `model`,
`effort` y `reason`: la configuración que el principal recomienda para el
revisor y por qué. Los esfuerzos admitidos dependen del revisor: `low` a `max`
para Claude y `low` a `ultra` para Codex. La recomendación forma parte del
prompt aprobado y de su huella, se muestra en el diálogo de confirmación y se
guarda con el encargo.

Es una recomendación declarada. El MCP no cambia el modelo de una sesión
abierta: el usuario lo cambia con `/model` en la terminal del revisor antes de
aprobar. El revisor compara la recomendación con su modelo y, si no coincide,
no reclama el encargo y avisa. El esfuerzo real de la sesión no se verifica.

### Delegar por nivel en Claude (sin cambiar `/model`)

El plugin `niveles` de este repositorio añade cuatro agentes de Claude con
modelo y esfuerzo fijos en su definición: `niveles:nivel-ligero` (`haiku`,
`low`), `niveles:nivel-normal` (`sonnet`, `medium`), `niveles:nivel-exigente`
(`sonnet`, `high`) y `niveles:nivel-alto` (`opus`, `high`). Instálalo una vez:

```text
/plugin marketplace add Jcabr3ra1/nexakit
/plugin install niveles@agent-toolkit
```

La sesión principal clasifica la tarea con la tabla de la skill y delega el
código al agente de ese nivel, así que no hace falta `/model` ni reiniciar. La
sesión principal se queda en una configuración fija y barata, lo que además
conserva su caché de prompts: cambiar de modelo o de esfuerzo a mitad de sesión
la invalida. El agente delegado tiene su propia caché y empieza sin la
conversación, así que la delegación debe llevar un encargo completo. Se probó
con una sesión `sonnet` que delegó en `niveles:nivel-ligero`: el uso de modelo
registró `haiku`. El esfuerzo del archivo no se verificó de la misma forma.

## Uso diario con la skill

La skill `skills/revisar` reduce el uso diario a un comando por
terminal y aprueba cada encargo por separado, con la recomendación delante;
solo usa `autoReviews` si el usuario lo pide. Instálala en `~/.claude/skills/`
y `~/.codex/skills/`:

> En la terminal que va a trabajar: `/programar <tarea>` (Claude) o
> `$programar <tarea>` (Codex).
>
> En la otra terminal: `/revisar` (Claude) o `$revisar` (Codex).

`/estado` (o `$estado`) muestra en una tabla las colaboraciones abiertas, qué
encargo está pendiente, quién debe actuar y el último veredicto, sin modificar
nada.

## Rendimiento de los modelos

Después de verificar un informe, el principal llama `record_review_outcome` una
sola vez con el veredicto, los hallazgos recibidos, cuántos se sostuvieron, el
nivel de la clasificación y su propia configuración. Solo puede hacerlo quien
envió el encargo y solo si está completado.

```sh
node bin/agent-toolkit-inbox.js rendimiento [--project-root /ruta] [--json]
```

resume esos resultados por revisor, modelo, esfuerzo y nivel: encargos,
hallazgos, porcentaje que se sostuvo y veredictos. Sirve para ajustar la
clasificación con datos propios. No usa ningún modelo.

```sh
node bin/agent-toolkit-inbox.js modelos [--json]
```

lista los alias de Claude y los modelos que Codex tiene disponibles
(`~/.codex/models_cache.json`, o `CODEX_HOME`), los clasifica por su descripción
(ligero, trabajo diario, más capaz, anterior) y genera la tabla de niveles con
los nombres vigentes, además de la configuración actual de Codex. La skill lo
consulta antes de recomendar, así que no queda desactualizada cuando cambian
los modelos.

```sh
node bin/agent-toolkit-inbox.js agentes [--escribir [--forzar]] [--json]
```

prepara los agentes por nivel de **Codex** (`nivel_ligero`, `nivel_normal`,
`nivel_exigente` y `nivel_alto`) en `~/.codex/agents` (o `CODEX_HOME`) con el
modelo y el esfuerzo de la tabla de niveles; los de Claude vienen del plugin
`niveles`. Sin `--escribir` solo muestra la vista previa. **Nunca sobrescribe ni
borra:** un archivo que ya existe con otro contenido, un enlace o un directorio
se respetan, y con `--escribir --forzar` se apartan enteros como
`nivel_<nivel>.toml.anterior-<fecha>-<id>` antes de crear el nuevo, así que no
se pierde nada aunque otro proceso cambie el archivo a la vez. Si
`models_cache.json` no se puede leer, no escribe nada. Vuelve a ejecutarlo con
`--forzar` cuando cambien los modelos. Al delegar en Codex, la sesión principal
nombra el agente (por ejemplo, `nivel_alto`); `xhigh` se pide por llamada solo si
`high` ya falló.

`revisar` contiene todas las reglas de la revisión, que solo ocurre cuando la
persona la pide. Los subagentes de `niveles` sirven para cualquier tarea
delegada, no solo para revisar.

## Esperar sin consumir el modelo

Esperar con `wait_for_peer_handoff` en bucle consume un turno del modelo en cada
vuelta, aunque no llegue nada. Para esperas largas usa el comando
`agent-toolkit-inbox`, que lee la bandeja sin usar ningún modelo:

```sh
node bin/agent-toolkit-inbox.js wait --agent claude --project-root /ruta/al/proyecto --timeout-seconds 3600
node bin/agent-toolkit-inbox.js wait --agent codex --project-root /ruta/al/proyecto --task <taskId> --review <reviewId>
```

Sin `--task` espera un encargo pendiente para ese agente en cualquier
colaboración abierta de la raíz; con `--task` y `--review` espera a que ese
encargo tenga informe o termine. Consulta la bandeja cada 2 segundos y escribe
una línea JSON con `state` (`handoff`, `finished`, `closed` o `timeout`), el
`taskId` y un resumen del encargo sin el prompt ni el informe. Sale con 0 si hay
resultado, 3 si se agota el tiempo, 2 por uso incorrecto y 1 ante un error. No
reclama ni modifica nada.

Claude Code lo ejecuta en segundo plano y solo vuelve a usar el modelo cuando el
comando termina: la espera no gasta tokens.

**Codex no tiene ese segundo plano.** Su herramienta de shell devuelve el
control cada ~60 s con «Script running…» y el modelo debe llamar otra vez a
`wait`, un turno que relee todo el contexto de la sesión. En las tres sesiones
de Codex del 26/10 hubo 55 turnos de espera sin trabajo, unos 5,6 millones de
tokens de entrada (99,8 % de caché) y unos 1.900 de salida; el coste de cada
vuelta crece con el contexto (de 33 mil a 215 mil tokens en la sesión más
larga). Lo que se hace para acotarlo, y que la skill indica al revisor de Codex:

- pedir el mayor `yield_time_ms` que acepte la herramienta (empezando por
  `600000`), y volver a llamar `wait` sin escribir texto entre vueltas;
- dedicar a `$revisar` una sesión corta, o hacer `/new` o `/compact` antes de
  esperar, porque cada vuelta cuesta proporcionalmente a su contexto;
- no relanzar la espera tras un `timeout` sin que el usuario lo pida.

Si el límite de ~60 s no se puede ampliar, la espera sigue costando una vuelta
por minuto. Por eso hay una vía sin espera:

```sh
node bin/agent-toolkit-inbox.js registrar --agent codex --project-root /ruta/al/proyecto [--thread <id>]
node bin/agent-toolkit-inbox.js avisar --project-root /ruta/al/proyecto --task <taskId> --review <reviewId>
```

`registrar` (en la sesión de Codex, con `$revisar`) guarda el id de esa sesión
como revisora del proyecto en `~/.agent-toolkit/workflows/reviewers` (0600). La
encuentra sola si es la única sesión de Codex que escribió en ese proyecto en los
últimos 2 minutos; si no, se indica con `--thread` (`/status` en Codex). Después
Codex **termina su turno y no espera**. Cuando el usuario aprueba un encargo
para Codex, el principal ejecuta `avisar`, que entrega con `codex queue` un
aviso fijo y corto (taskId, reviewId y raíz) a esa sesión, la cual lo atiende
con `claim_peer_review` y `submit_peer_review`.

Se probó con una sesión de Codex inactiva: el mensaje encolado llegó como mensaje
de usuario en el mismo segundo y la sesión respondió.

Límites y garantías:

- El MCP sigue siendo pasivo: no despierta nada. El aviso es una orden explícita
  del principal (el cliente la pide al usuario) y solo se emite para un encargo
  aprobado, `pending`, dirigido a Codex, en una colaboración abierta y con un
  revisor registrado hace menos de 24 horas. No hay forma de enviar otro texto.
- El aviso no lleva el prompt del encargo, solo identificadores: Codex obtiene el
  prompt aprobado, con su huella, al reclamar.
- Es un mensaje de usuario normal en la sesión de Codex, con sus permisos. Si
  Codex está en mitad de un turno, queda en cola hasta que termine.
- Si `codex queue` falla o no hay sesión registrada, el encargo sigue pendiente
  en la bandeja y se puede usar la espera con las medidas de arriba.

## Del cambio al informe

1. El principal publica un contexto completo actualizado con
   `publish_peer_context`, indicando `expectedRevision`. Debe incluir decisiones,
   cambios, límites y comprobaciones realmente realizadas. La publicación
   sustituye el contexto actual y mantiene un historial limitado; no es un append.
2. Prepara `preview_peer_review`: `from`, `to`, solicitud y lista explícita de
   archivos relativos. Puedes usar Claude → Codex o Codex → Claude en cualquier
   momento; no se exige una planificación previa de Codex.
3. La vista previa muestra el prompt completo, la versión del contexto, las rutas
   y las huellas. Prepararla no envía el encargo. El principal muestra todo al
   usuario, espera aprobación directa y llama `approve_peer_review` con su
   `previewId` y código. El cliente presenta además una confirmación interactiva.
4. El receptor recibe el encargo aprobado mediante `wait_for_peer_handoff` y lo
   reclama con `claim_peer_review`, indicando su rol. La reclamación comprueba
   de nuevo los archivos y solo puede ganarla una sesión. Devuelve un
   `claimToken`; consérvalo para la entrega y no lo publiques en el informe.
5. El receptor inspecciona los archivos desde su terminal y entrega hallazgos,
   evidencia y límites con `submit_peer_review`. No se atribuye pruebas que no
   hizo. El MCP verifica el comprobante y las huellas antes de guardar el informe.
6. El principal consulta `get_collaboration`, o espera el resultado con
   `wait_for_peer_handoff` indicando `reviewId`. Recupera el informe y comprueba
   su vigencia antes de aplicar correcciones. Puede publicar otro contexto y
   solicitar una revisión nueva, con otra aprobación.

Los roles se pueden intercambiar: `primaryAgent` documenta quién empezó y no
bloquea la dirección siguiente. Se admite un encargo pendiente o reclamado por
tarea, para no duplicar revisiones del mismo punto de trabajo.

## Qué significan las huellas y los estados

- `pending`: encargo aprobado disponible en la bandeja.
- `claimed`: una sesión lo reclamó y conserva su comprobante de entrega.
- `completed`: se guardó un informe para el contexto y los archivos revisados.
- `stale`: cambió el contexto o los archivos; hay que preparar otro encargo.
- `cancelled`: el encargo se canceló o la colaboración se cerró.

Las huellas cubren el contenido de los archivos enumerados, incluyendo archivos
ausentes, y la raíz vinculada a la tarea. No incluyen archivos fuera de esa
lista, el estado Git completo, dependencias ni evidencia de ejecución de pruebas.
Añade explícitamente los archivos que el revisor necesite inspeccionar. Se
rechazan directorios, recorridos fuera del proyecto, carpetas privadas, enlaces
simbólicos, enlaces duros y archivos demasiado grandes.

Si los archivos cambian antes de enviar, la aprobación falla. Si cambian antes
de reclamar o al entregar, el encargo queda `stale` y no se guarda el informe
como una revisión válida. Publicar contexto nuevo invalida los encargos activos
de la versión anterior. Si cambian después de un informe ya guardado,
`get_collaboration` conserva el historial y devuelve `current: false`,
`filesCurrent: false` o `contextCurrent: false`. Un resultado de espera es una
notificación; consulta `get_collaboration` para comprobar su vigencia actual.

Una reclamación no se reasigna automáticamente si cierras su terminal. Cancela
ese encargo y prepara uno nuevo con aprobación. `cancel_peer_review` evita una
entrega posterior pero no puede interrumpir la sesión nativa. Si sigue
trabajando, detén esa sesión desde su terminal. `close_collaboration` cancela
sus encargos activos y conserva los informes para consulta.

## Permisos, almacenamiento y límites

Este es un intercambio local entre clientes de confianza del mismo usuario.
Los roles y autores son declarados: no acreditan qué modelo o identidad produjo
un informe. El MCP no cambia los permisos de las sesiones abiertas. El encargo
solicita lectura, pero no crea un sandbox ni impide técnicamente que una sesión
con permisos de escritura los use. Configura los permisos del revisor en su
cliente. El flujo [de CLIs aisladas](task-workflow-mcp.md) sigue disponible.

Los registros guardan contexto, prompts aprobados, huellas e informes que los
agentes entregan explícitamente, no conversaciones completas, razonamiento
privado ni diagnósticos brutos de CLIs. No envíes credenciales o información
ajena al alcance. Los archivos se escriben de forma atómica con permisos `0600`
en un directorio `0700`, y las operaciones usan bloqueos compartidos entre
procesos para evitar reclamaciones o entregas duplicadas.
Si un proceso cae mientras mantiene un bloqueo, el MCP no lo elimina por edad
ni asume que es seguro repetir la operación. El historial sigue siendo legible;
para recuperar el trabajo puedes crear otra colaboración. La limpieza manual
del bloqueo exige comprobar primero que ningún proceso siga usando esa tarea.

Cada vista previa es de un solo uso, vence a los 20 minutos y se aprueba en la
misma conexión MCP que la preparó. Una reconexión descarta las vistas previas,
pero conserva tareas, encargos aprobados e informes. Se guardan hasta 16
revisiones y 16 versiones de contexto por colaboración. El contexto admite
8 000 bytes, el informe 16 000, el prompt 32 000, hasta 64 archivos de 2 MB cada
uno y 8 MB por captura. Al alcanzar el límite de revisiones, crea otra tarea.

## Criterios y verificación

El modo debe permitir ambas direcciones, compartir datos entre procesos MCP
distintos y después de reabrirlos, bloquear envíos sin aprobación o fuera del
proyecto, aceptar una sola reclamación y detectar entregas desactualizadas.
No debe invocar modelos ni modificar archivos del proyecto por sí mismo.

Las pruebas incluyen dos clientes y dos procesos MCP reales, con CLIs ficticias
que registran cualquier intento de invocación. Comprueban el intercambio completo
en ambos sentidos, las aprobaciones, el guardado, el aislamiento y que las CLIs
no se ejecutan. También cubren cancelación, expiración, concurrencia y cambios
durante la revisión. No sustituyen una demostración con sesiones reales de
Claude y Codex; esa demostración necesita conexión y autorización del usuario.
