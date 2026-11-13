# Ahorro y consumo en Codex

NexaKit puede auditar el contexto, registrar contadores informados por Codex,
recortar salidas de comandos y comparar mediciones. No convierte los tokens de
una suscripción en dólares ni garantiza un porcentaje de ahorro.

## Revisar antes de cambiar

Desde el checkout de desarrollo:

```sh
node bin/nexakit.js codex auditar --project .
node bin/nexakit.js codex auditar --project . --json
node bin/nexakit.js codex preparar --salida /ruta/nueva/codex-ahorro
```

La auditoría revisa campos permitidos de configuración, metadatos de skills e
instrucciones. No ejecuta skills, consulta modelos ni muestra la configuración
completa. Informa límites de cobertura: no reproduce todas las capas de
configuración gestionada, plugins o habilidades remotas del cliente abierto.

Las recomendaciones de catálogo y salida son puntos de partida para evaluar,
no valores oficiales óptimos. Reducir mucho el catálogo puede ocultar skills;
recortar mucho una salida puede obligar a leer el log completo. No se eliminan
skills ni se cambia el modelo por una recomendación.

### Presupuesto del catálogo de skills

El paquete generado deja `skills.max_context_tokens` sin fijar: Codex calcula
su presupuesto nativo según el contexto del modelo. Las versiones anteriores
de NexaKit proponían `2000`; ese límite puede eliminar descripciones y dejar
skills fuera de la lista inicial. Regenerar el paquete no migra tu configuración
activa: revisa ese valor si ya lo habías copiado.

Antes de recortar, compara la lista y los avisos de una sesión nueva. En clientes
con el comando de diagnóstico disponible puedes inspeccionar el prompt sin
inferencia, usando una sustitución temporal:

```sh
codex debug prompt-input -c 'skills.max_context_tokens=6000'
```

La salida contiene instrucciones y rutas locales: consérvala en privado.
El número del ejemplo no es una recomendación universal. Comprueba los nombres
disponibles, sus descripciones y las advertencias de omisión. Si necesitas
ajustar el límite, respalda primero `config.toml`; Codex admite como máximo
`10000`. No desactives skills únicamente para quitar un aviso.

Este presupuesto cubre la lista inicial; las instrucciones completas de una
skill se leen al utilizarla. Aumentarlo puede recuperar capacidades, pero no
demuestra ahorro neto de tokens. Consulta la [documentación oficial de
skills](https://learn.chatgpt.com/docs/build-skills).

## Preparar los hooks

```sh
node bin/nexakit.js codex preparar --salida /ruta/nueva/codex-ahorro --apply
```

Solo crea un paquete en una carpeta nueva. El README generado explica la
activación manual y los archivos preparados. No sustituye `~/.codex/config.toml`
ni los hooks existentes. Revisa y combina los fragmentos con tu configuración;
Codex requiere confiar en los hooks antes de ejecutarlos. No uses opciones que
salten esa revisión. Respeta `CODEX_HOME` cuando la instalación lo personaliza.

El paquete incluye un observador `PostModelRequest`, recomendaciones mediante
`UserPromptSubmit` y orientación breve de sesión/compactación. El observador guarda solo metadatos seleccionados y
contadores disponibles. No guarda prompts, argumentos de herramientas,
transcripciones ni mensajes de error del proveedor. Un contador ausente sigue
siendo desconocido. Su cobertura depende de que el cliente emita esos eventos.

Las configuraciones gestionadas y la orquestación en la nube pueden tener
soporte diferente. Probar el comando con un fixture no demuestra que una sesión
abierta haya cargado el hook.

## Barra y recomendaciones en Codex de terminal

La configuración preparada incluye la barra nativa con modelo y esfuerzo,
contexto restante, límites de 5 horas y semanal, tokens de entrada y salida y
rama Git. Codex omite los datos que no estén disponibles. En terminales
estrechas recorta los últimos campos: usa `/statusline` para elegir el orden.
Estos datos vienen del cliente, no de estimaciones de NexaKit.

Al **enviar** un mensaje sustantivo aparece un aviso breve con la recomendación
local de NexaKit: modelo, esfuerzo, razón y comando `/model`, o delegación a un
nivel. No aparece mientras escribes y no es texto insertado en el pie de la
barra. Confirmaciones como «sí» y «listo» quedan en silencio.

Cuando el [equipo de agentes](codex-agentes.md) está instalado, ese mismo hook
puede añadir al principal orientación de selección de perfiles disponibles.
El aviso visible y la orientación no lanzan agentes por sí solos.

## Recorte automático y actividad

### Antes de ejecutar: comandos simples

`PreToolUse` con matcher `^Bash$` envuelve automáticamente comandos literales
de pruebas, build y lint con `nexakit codex ejecutar`. Así el proceso ya devuelve
el resumen, incluso cuando se llama desde modo de código. El hook no ejecuta
el comando: Codex ejecuta la entrada reescrita una sola vez, bajo los permisos
de la sesión. No se instala ningún hook `PermissionRequest`.

El modo automático usa una carpeta temporal privada del usuario para guardar
logs y métricas, sin necesitar acceso adicional a su carpeta personal desde el
sandbox. El aviso contiene la ruta exacta; el sistema operativo puede limpiar
estos temporales. El wrapper explícito mantiene su almacenamiento habitual.
`nexakit ahorro` consulta ambos registros sin duplicar una misma ruta, con
lecturas acotadas y sin seguir enlaces. Si el sistema limpia los temporales,
sus métricas dejan de estar disponibles en ese resumen local.

El alcance es POSIX y deliberadamente limitado: gestores de paquetes con tareas
conocidas y `node --test`. No interpreta shell general: comillas, variables,
globs, pipes, redirecciones, comandos compuestos, watch, terminal interactiva
y solicitudes explícitas de escalación quedan sin modificar. Windows mantiene
el wrapper explícito. `NEXAKIT_SALIDA=completa` omite la reescritura.

Para verificarlo, ejecuta un comando elegible que produzca salida larga y
comprueba el aviso de líneas omitidas y la ruta del log. Una salida corta
permanece completa. El wrapper conserva cwd, argumentos literales y código
de salida; un resumen no convierte una prueba fallida en aprobada.

Comprobación nativa del 13 de noviembre de 2026: `PreToolUse` confiado devolvió
el resumen también a la llamada anidada de código. Una ejecución produjo
15.626 caracteres originales y 2.343 en el resultado, con las 400 líneas
conservadas en el log privado. Se comprobaron además ejecución única, error
con exit 1 visible, continuación posterior y bypass completo. Son caracteres
de ese caso, no tokens ni un porcentaje de ahorro garantizado.

### Después de ejecutar: cobertura adicional

El paquete incluye `PostToolUse` con matcher `^Bash$`. Tras revisar y confiar
este hook con `/hooks`, NexaKit puede sustituir salidas largas por un resumen
con ruta al original privado. No reescribe ni vuelve a ejecutar el comando.
Los fallos con estado explícito, el texto con señales de error cuando falta
estado, las respuestas desconocidas y los procesos activos se conservan.
Codex puede entregar solo texto sin código de salida: en ese caso el resumen
indica `exit_code: desconocido` y no acredita éxito. Si no puede guardar el original, no
sustituye la salida. Las herramientas alojadas y algunos caminos especializados
no están cubiertos por este hook.

El original se conserva en `~/.nexakit/codex/salidas/`, con permisos privados.
Puede contener datos sensibles de la salida del comando; no se sube al repositorio
ni se elimina automáticamente. `NEXAKIT_SALIDA=completa` permite omitir el recorte.
El wrapper `codex ejecutar` continúa disponible cuando se necesita control
explícito o el cliente no admite el hook.

Los hooks `SubagentStart` y `SubagentStop` guardan metadatos locales, sin prompt,
respuesta ni transcripción. Consulta:

```sh
nexakit codex actividad
nexakit codex actividad --json
```

Un inicio y un fin con el mismo `agent_id` acreditan eventos recibidos del
subagente; no prueban por sí solos que su tarea fue correcta. Comprueba también
el resultado y `/subagents`. Un modelo ausente se muestra como desconocido.
Los registros no prueban cobertura completa ni ahorro de tokens. En modo de
código, un script puede conservar el resultado original de una herramienta;
no supongas que un log guardado prueba por sí solo que todo camino redujo el
contexto del modelo.

En la comprobación local con Codex CLI `0.167.2`, `PostToolUse` guardó el original
exacto, pero el resultado del comando siguió llegando completo al script de
modo de código. Ese caso no acredita ahorro automático de contexto. El wrapper
`nexakit codex ejecutar -- programa argumentos` sí devolvió el resumen y
conservó el original. Por eso los comandos elegibles usan ahora `PreToolUse`
para insertar ese wrapper antes de ejecutarse. Para los demás, úsalo de forma
explícita si necesitas un recorte comprobable.

Si ya tenías hooks instalados, regenera el paquete y agrega los eventos nuevos
que falten, incluido `PreToolUse`, sin reemplazar otros hooks. Respalda `hooks.json` antes
de combinarlo; Codex exige revisar y confiar las definiciones nuevas con `/hooks`.
Una sesión abierta puede requerir reinicio para cargar perfiles y hooks.

```sh
node bin/nexakit.js codex recomendar --tarea "Escribe pruebas para el parser"
node bin/nexakit.js codex recomendar --tarea "Ejecuta las pruebas" --json
```

El recomendador lee el catálogo local que Codex ya descargó. Clasifica la tarea
con reglas locales; no consulta otro modelo ni gasta cuota para recomendar.
Si falta un modelo o esfuerzo soportado, lo informa. La configuración guardada
se etiqueta como tal: solo la barra y `/status` acreditan lo activo en la sesión.

Para aplicar una sugerencia usa el comando mostrado, por ejemplo
`/model <modelo-disponible> --reasoning=<esfuerzo-soportado>`. NexaKit nunca lo
ejecuta por ti. Para trabajos mecánicos puede recomendar un subagente ligero
manteniendo el modelo principal; por eso seguir viendo Sol no demuestra que
todos los subagentes estén usando Sol.

Tras combinar la configuración, abre Codex y confía los cinco hooks con
`/hooks`. Si no confías `UserPromptSubmit`, no aparecerán las recomendaciones.

## Ejecutar comandos con salida acotada

```sh
node bin/nexakit.js codex ejecutar -- npm test
NEXAKIT_SALIDA=completa node bin/nexakit.js codex ejecutar -- npm test
node bin/nexakit.js ahorro --json
```

El ejecutor recibe un programa y sus argumentos literalmente, sin un shell
implícito. Conserva el código de salida y guarda el log completo localmente;
la salida resumida conserva comienzo, final y posibles errores. Para una
tubería o redirección usa deliberadamente el shell que corresponda, por ejemplo
`codex ejecutar -- sh -c 'comando | otro'`.

En Windows los archivos `.cmd` y `.bat` necesitan un intérprete explícito;
para npm puedes ejecutar `node` con la ruta de `npm-cli.js`. No se añade un
shell automáticamente, para conservar el significado literal de los argumentos.

Los logs de comandos pueden contener información sensible: no los añadas al
repositorio ni a la memoria. Los caracteres recortados y los tokens estimados
del informe `ahorro` no equivalen al consumo total ahorrado. El ejecutor se usa
explícitamente: no intercepta todos los comandos de una sesión por instalarlo.

## Consultar y evaluar

```sh
node bin/nexakit.js codex consumo --json
node bin/nexakit.js codex comparar --antes antes.json --despues despues.json --json
```

Compara la misma tarea, un resultado que cumpla los mismos criterios y muestras
con cobertura comparable. Conserva los datos originales para revisar la
comparación. Entrada en caché ya forma parte de entrada: no se suma de nuevo.
Una muestra incompleta o un resultado de peor calidad no acredita ahorro.

Cada archivo de comparación contiene la misma identidad de tarea, una
comprobación de calidad declarada y mediciones individuales. Ejemplo ficticio
para el formato; sustituye los valores por contadores observados:

```json
{
  "task": "corregir-validacion-ejemplo",
  "quality": { "passed": true },
  "measurements": [{
    "id": "llamada-1",
    "agent": "codex",
    "phase": "implementation",
    "model": "modelo-observado",
    "source": "client-reported",
    "inputTokens": 1200,
    "cacheReadTokens": 900,
    "outputTokens": 100,
    "totalTokens": 1300,
    "durationMs": 2300
  }]
}
```

La calidad la declara quien prepara la muestra: el comparador no ejecuta las
pruebas ni verifica por sí mismo que ambas tareas fueran equivalentes. Cambios
de modelo, procedencia o fase impiden atribuir un ahorro comparable.

Para un piloto útil, elige varias tareas pequeñas y grandes y repite con y sin
la mejora. Registra modelo, esfuerzo, contexto, entrada/caché/salida, duración,
reintentos y calidad. No atribuyas diferencias de una sola tarea a NexaKit.

## Esfuerzo, delegación y contexto

- Empieza con el esfuerzo adecuado para el trabajo; reserva comprobaciones
  profundas para bugs, seguridad y casos borde. Cambiarlo sigue siendo tu decisión.
- Resuelve comandos pequeños en la sesión principal. Delega trabajos extensos
  y delimitados, con un informe breve; no dupliques una búsqueda ya delegada.
- Mantén una conversación por resultado coherente. Al compactar, conserva
  objetivo, rama, archivos, decisiones, pendientes y pruebas realmente ejecutadas.
- Selecciona MCP y skills por proyecto y evita reconfigurarlos repetidamente
  durante una tarea. La cantidad instalada no demuestra cuánto contexto consumen.

## Fuentes y compatibilidad

Documentación oficial consultada el 12 de noviembre de 2026:

- [Hooks y contadores](https://learn.chatgpt.com/docs/hooks).
- [Configuración y límites](https://learn.chatgpt.com/docs/config-file/config-reference).
- [Carga progresiva de skills](https://learn.chatgpt.com/docs/build-skills).
- [Coste de los subagentes](https://learn.chatgpt.com/docs/agent-configuration/subagents).
- [Cuota, créditos y precios](https://learn.chatgpt.com/docs/pricing).

Los mods `nexakit-ahorro`, `nexakit-sesion` y `nexakit-modelo` de Claude Code
conservan su implementación propia. Esta integración de Codex utiliza la CLI y
los eventos documentados de Codex; no supone compatibilidad de esos mods.
