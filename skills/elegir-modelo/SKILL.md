---
name: elegir-modelo
description: Úsala cuando haya que recomendar, cambiar o comprobar el modelo o el esfuerzo (effort, reasoning effort) de Claude Code, Codex o Antigravity: al empezar una tarea, al cambiar de tipo de trabajo, antes de pedir una revisión a otra IA, cuando un resultado salió mal o cuando el usuario pregunte qué modelo o esfuerzo usar.
---

# Elegir modelo y esfuerzo

El **modelo** decide cuánto sabe y razona la IA; el **esfuerzo**, cuánto trabajo hace en cada turno: cuánto lee, verifica y decide sola. Se eligen por separado. Fuentes: Anthropic (Thariq Shihipar, «Spending your effort»; Lydia Hallie, «Choosing a Claude model and effort level»; documentación de Claude Code). Hablan de Claude; en Codex y Antigravity se aplica el mismo principio por analogía.

## 1. Saca los nombres reales

Ejecuta `node <carpeta de esta skill>/modelos.mjs`. Lista, para las tres IA, los modelos y esfuerzos que existen, el esfuerzo por defecto de cada modelo y lo que está guardado ahora. Usa solo esos nombres. Si no puedes ejecutarlo, pide al usuario la salida de `/model` (Claude, Codex) o de `agy models`. Un nombre escrito de memoria o copiado de otra skill puede no existir.

## 2. Esfuerzo: el por defecto de cada modelo, salvo tres casos

El esfuerzo es una preferencia estable, no se ajusta tarea por tarea. Parte del por defecto que da el script (Claude 5.5: `medium`; en Codex cada modelo trae el suyo). Aplica la primera fila que se cumpla:

| Si… | Esfuerzo |
| --- | --- |
| Se va a iterar con el usuario o la tarea es simple | `low` |
| Verificar importa: bug en código existente, casos borde, seguridad, un error escondido costaría caro | `high` |
| Larga, difícil, crítica y se deja trabajar sola durante horas | `xhigh` |
| Todo lo demás, o hay duda | el por defecto |

Que una tarea sea larga no la hace `high`. `max` y `ultra` casi nunca: tardan horas y pueden pensar de más. Ciclo recomendado: construir en el por defecto y verificar al final en `high`; en Claude, cambiar de esfuerzo a mitad de sesión no rompe la caché.

## 3. Modelo: papeles y cómo reconocerlos

La elección se hace por **papel**, no por nombres fijos que caducan:

| Papel | Cuándo usarlo | Cómo reconocerlo en `modelos.mjs` | Ejemplo con fecha (a 2026-11: usar solo lo que devuelva el script) |
| --- | --- | --- | --- |
| **ligero** | Solo comandos y cambios mecánicos, ediciones precisas o preguntas sobre código ya en contexto | `papel: ligero`, descripción *fast and affordable / lightweight / easier tasks* o familias `haiku`, `luna`, `flash` | a 2026-11: Claude `haiku`, Codex `gpt-6-luna`, Antigravity `gemini-3.8-flash-*` |
| **uso diario** | Implementar con un diseño claro, el trabajo habitual de programación | `papel: uso diario`, descripción *workhorse / everyday / balanced* o familias `sonnet`, `sol`, `terra`, `hydrogen` | a 2026-11: Claude `sonnet`, Codex `gpt-6.1-sol` o `gpt-6.1-terra`, Antigravity `gemini-4-hydrogen-*` |
| **el más capaz** | Diseño, bugs sutiles y ambigüedad, dominios nuevos o arquitectura | `papel: el más capaz`, descripción *frontier / most demanding* o familias `opus`, `astra`, `argon`, `carbon` | a 2026-11: Claude `opus` (o `opusplan`), Codex `gpt-6-astra`, Antigravity `gemini-4-argon-*` o `gemini-4-carbon-*` |

- **Modelos nuevos y clasificación por familia:** entran modelos nuevos con frecuencia (por ejemplo, `gpt-6.1-terra`, que llega sin descripción útil). Si un modelo no tiene una descripción que indique su papel, `modelos.mjs` lo clasifica por su familia (`luna`, `terra`, `sol`, `astra`, `flash`, `argon`, `haiku`, `sonnet`, `opus`…) usando la descripción de la generación anterior de esa misma familia. Si no hay generación anterior ni familia conocida, queda marcado como `sin clasificar`: en ese caso, **pregunta al usuario en vez de adivinar**.
- **Generaciones pasadas:** los modelos marcados con `papel: anterior` (*older* / *previous generation*) no se recomiendan salvo que el usuario los pida expresamente.
- **Límites y cuota:** un aviso de límite o de cuota nunca baja el modelo sin decírselo al usuario. Si una cuenta se acerca al límite o agota cuota, informa al usuario y espera su decisión antes de pasar a otro modelo o a otra IA.

### Elegir Gemini en Antigravity

- **Flash 3.8** con `low` para consultas breves o cambios mecánicos y con `medium` para trabajo rutinario si la cuenta ofrece esa variante. [Gemini 3.8 Flash](https://antigravity.google/blog/gemini-3-8-flash-in-google-antigravity/)
- **Hydrogen** con `low` para iterar rápido, `medium` para implementar con un diseño claro y `high` (el predeterminado del modelo) para depurar, escribir pruebas o verificar cambios. Reserva `xhigh` para una tarea de implementación exigente que requiera más razonamiento dentro de la misma familia. [Gemini 4 Hydrogen](https://antigravity.google/blog/gemini-4-hydrogen-in-google-antigravity)
- **Argon** con `medium` para investigación o análisis con alcance definido y `high` para arquitectura, migraciones o depuración con dependencias difíciles. [Gemini 4 Argon](https://antigravity.google/blog/gemini-4-argon-in-google-antigravity)
- **Carbon** para auditorías críticas, problemas abiertos y trabajo largo de alto riesgo. Usa `high` para una verificación profunda y `medium` si la parte a resolver ya está acotada. Comprueba las variantes de la cuenta antes de recomendarlo. [Gemini 4 Carbon](https://antigravity.google/blog/gemini-4-carbon-in-google-antigravity)

Estas son pautas de uso. `agy models` determina qué pares de modelo y esfuerzo están disponibles. [Esfuerzo en Antigravity CLI](https://antigravity.google/docs/cli/commands/effort/)

## 4. Cambiar a mitad de sesión cuesta caché

Cada modelo tiene su propia caché: tras un `/model`, el turno siguiente relee todo el historial sin ella. Ese turno puede costar más de lo que se ahorra con el cambio, y más cuanto más contexto haya. Cambiar el esfuerzo **no** rompe la caché en Claude 5.x con suscripción o clave de API; en Bedrock, Google Cloud o una pasarela, sí la rompe.

- Elige modelo y esfuerzo **al empezar** la sesión. A mitad de tarea, ajusta antes el esfuerzo que el modelo.
- Para lo mecánico (comandos, búsquedas, lint, commit) no bajes la sesión a `haiku`: **delega** en un subagente `nivel-ligero`. Tiene su propia caché y no toca la de la sesión.
- Para un fallo difícil con mucho contexto ya cargado (más o menos del 30 % en adelante), delega en `nivel-alto` en vez de pasar la sesión a `opus`. Con poco contexto, cambiar sale barato.
- Si el subagente necesita el mismo contexto que llevas, usa una bifurcación (fork): hereda la caché del padre.
- `opusplan` cambia de modelo cada vez que entras o sales del modo plan, así que cada cambio es un turno sin caché. Úsalo cuando planificas una vez y luego ejecutas largo, no si alternas a menudo.
- `fable` es el más caro por token: resérvalo para trabajo largo y ambiguo que de verdad lo necesite.
- `/usage` muestra el acierto de caché (`Prompt cache (main)`), y la barra de `nexakit-modelo` también (`caché N%`). Si baja de golpe, algo cambió el prefijo: un cambio de modelo, un MCP o un plugin.

### Qué salida elegir, de la más barata a la más cara

Aplica la primera que resuelva el caso (es el mismo criterio que usa la barra de `nexakit-modelo`):

| Situación | Salida | Coste |
| --- | --- | --- |
| Pregunta corta o explicación de algo ya en contexto | bajar el esfuerzo a `low` | ninguno; ahorra razonamiento |
| Fallo normal en código existente | subir el esfuerzo a `high`, mismo modelo | ninguno de caché |
| Escribir pruebas o cubrir casos borde | subir el esfuerzo a `high`, mismo modelo (es el trabajo de `nivel-exigente`) | ninguno de caché |
| Tarea mecánica (commit, push, lint, búsquedas) | delegar en `nivel-ligero`, solo si lee mucho o devuelve mucho ruido; si es pequeña, hazla en la sesión | un subagente pequeño |
| Fallo que ya se intentó y sigue, intermitente, de seguridad o concurrencia | con poco contexto o caché fría, cambiar al más capaz; si no, delegar en `nivel-alto` | relectura sin caché, o un subagente |
| Diseño o arquitectura | el más capaz; con mucho contexto, mejor en sesión nueva | relee todo el contexto si se cambia a mitad |
| Cinco o más turnos de rutina en un modelo más caro del necesario | sesión nueva en el modelo de uso diario | ninguno; deja de pagar de más en cada turno |
| Límite de uso al 80 % o más y trabajo de diseño | modelo de uso diario con `high`, avisando al usuario | ninguno de caché |

La caché está fría tras una hora sin actividad con suscripción (cinco minutos con clave de API): en ese momento cambiar de modelo no cuesta nada extra, y es el mejor momento para hacerlo o para abrir sesión nueva.

## 5. Si un resultado salió mal, diagnostica antes de subir

1. ¿Tenía buen contexto (instrucciones claras, archivos, herramientas)? Si no, arréglalo primero.
2. ¿Tenía todo, lo intentó y se equivocó? Le faltó saber: modelo más capaz.
3. ¿Se saltó un archivo, no corrió las pruebas o no verificó? Le faltó esfuerzo: sube un nivel.

Más esfuerzo no arregla un enfoque equivocado.

## 6. Responde con esta forma

| IA | Trabajo | Modelo | Esfuerzo | Por qué (una línea) |
| --- | --- | --- | --- | --- |

Cada modelo de la tabla se copia de la salida del script (o de la que te pasó el usuario). Si no tienes la de una IA, sus celdas de modelo dicen `pendiente` y debajo va el comando que la obtiene.

Debajo, una línea por IA con cómo cambiarlo y comprobarlo:

- **Claude:** `/model <alias>` y `/effort <nivel>`; se comprueba con `/effort status`. Si el script avisa de `CLAUDE_CODE_EFFORT_LEVEL`, esa variable manda.
- **Codex:** `/model` (modelo y esfuerzo); se comprueba con `/status`.
- **Antigravity:** selecciona con `/model` y `/effort`, o ejecuta `agy --model <id>` con la variante elegida. Comprueba la variante activa en el selector de la sesión.

Si lo guardado ya coincide, dilo en una línea y no pidas cambios. Lo que el script lee de archivos es lo guardado, no la sesión abierta: no lo presentes como comprobado.

## Mostrar la recomendación en Claude

Si está disponible la herramienta `nexakit_recomendacion` del mod opcional
`nexakit-modelo`, úsala tras recomendar: modelo, esfuerzo y motivo. Solo
muestra la recomendación; el usuario sigue aplicando cualquier cambio.
