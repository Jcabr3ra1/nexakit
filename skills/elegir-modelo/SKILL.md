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
| **uso diario** | Implementar con un diseño claro, el trabajo habitual de programación | `papel: uso diario`, descripción *workhorse / everyday / balanced* o familias `sonnet`, `sol`, `terra` | a 2026-11: Claude `sonnet`, Codex `gpt-6.1-sol` o `gpt-6.1-terra` |
| **el más capaz** | Diseño, bugs sutiles y ambigüedad, dominios nuevos o arquitectura | `papel: el más capaz`, descripción *frontier / most demanding* o familias `opus`, `astra`, `argon` | a 2026-11: Claude `opus` (o `opusplan`), Codex `gpt-6-astra`, Antigravity `gemini-4-argon-*` |

- **Modelos nuevos y clasificación por familia:** entran modelos nuevos con frecuencia (por ejemplo, `gpt-6.1-terra`, que llega sin descripción útil). Si un modelo no tiene una descripción que indique su papel, `modelos.mjs` lo clasifica por su familia (`luna`, `terra`, `sol`, `astra`, `flash`, `argon`, `haiku`, `sonnet`, `opus`…) usando la descripción de la generación anterior de esa misma familia. Si no hay generación anterior ni familia conocida, queda marcado como `sin clasificar`: en ese caso, **pregunta al usuario en vez de adivinar**.
- **Generaciones pasadas:** los modelos marcados con `papel: anterior` (*older* / *previous generation*) no se recomiendan salvo que el usuario los pida expresamente.
- **Límites y cuota:** un aviso de límite o de cuota nunca baja el modelo sin decírselo al usuario. Si una cuenta se acerca al límite o agota cuota, informa al usuario y espera su decisión antes de pasar a otro modelo o a otra IA.

## 4. Si un resultado salió mal, diagnostica antes de subir

1. ¿Tenía buen contexto (instrucciones claras, archivos, herramientas)? Si no, arréglalo primero.
2. ¿Tenía todo, lo intentó y se equivocó? Le faltó saber: modelo más capaz.
3. ¿Se saltó un archivo, no corrió las pruebas o no verificó? Le faltó esfuerzo: sube un nivel.

Más esfuerzo no arregla un enfoque equivocado.

## 5. Responde con esta forma

| IA | Trabajo | Modelo | Esfuerzo | Por qué (una línea) |
| --- | --- | --- | --- | --- |

Cada modelo de la tabla se copia de la salida del script (o de la que te pasó el usuario). Si no tienes la de una IA, sus celdas de modelo dicen `pendiente` y debajo va el comando que la obtiene.

Debajo, una línea por IA con cómo cambiarlo y comprobarlo:

- **Claude:** `/model <alias>` y `/effort <nivel>`; se comprueba con `/effort status`. Si el script avisa de `CLAUDE_CODE_EFFORT_LEVEL`, esa variable manda.
- **Codex:** `/model` (modelo y esfuerzo); se comprueba con `/status`.
- **Antigravity:** `/model` dentro de agy, o `agy --model <id>`; el esfuerzo va en el id. Solo se comprueba en su selector.

Si lo guardado ya coincide, dilo en una línea y no pidas cambios. Lo que el script lee de archivos es lo guardado, no la sesión abierta: no lo presentes como comprobado.

## Mostrar la recomendación en Claude

Si está disponible la herramienta `nexakit_recomendacion` del mod opcional
`nexakit-modelo`, úsala tras recomendar: modelo, esfuerzo y motivo. Solo
muestra la recomendación; el usuario sigue aplicando cualquier cambio.
