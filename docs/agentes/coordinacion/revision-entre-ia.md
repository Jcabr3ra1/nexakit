# Revisión entre IA en la misma terminal

La programación normal aplica contexto, plan proporcional, rama, pruebas,
implementación, comprobación y cierre con memoria. Al terminar una tarea con
cambios de código, las instrucciones piden una revisión a otra IA, verifican
sus hallazgos y resumen los arreglos. Una vez por tarea, máximo dos rondas.
Los cambios solo documentales y «sin revisión» omiten la revisión automática.
`/revisar` (o `$revisar`) pide una revisión adicional. `/programar` y `/estado`
se retiran. La automatización es una instrucción para la IA, sin hooks.

La primera revisión de la sesión pregunta el destino entre las otras IA
instaladas: antes de cada revisión se ejecuta `nexakit revision --disponibles --principal <IA>` (claude, codex o antigravity). La consulta es de solo lectura y no llama modelos. Se ofrecen las certificadas y las pendientes, avisando de que estas últimas se certifican la primera vez; las fallidas no se ofrecen. Claude usa el selector; Codex y Antigravity una
pregunta normal. Con una opción no pregunta; sin opciones avisa. Recomendadas:
Claude → Codex; Codex → Claude; Antigravity → Claude. La elección vive en la
conversación, no en las respuestas del asistente ni en archivos. «que lo revise
<IA>» la cambia; las revisiones siguientes anuncian el destino.

## Comandos

```text
nexakit revision --disponibles --principal codex
nexakit modelo
nexakit modelo --nivel Exigente --ia codex
nexakit revision --con codex --modelo <id real> --esfuerzo high --encargo <archivo> --base main
```

Las skills usan la orden estable `~/.nexakit/nexakit`, o `nexakit.cmd` en
Windows. El encargo debe ser un archivo de hasta 1 MiB. El contexto usa el
merge-base con HEAD e incluye commits de rama, índice, árbol de trabajo y
archivos no seguidos. Un diff mayor de 400 KiB falla indicando el tamaño;
revisa por partes, con una base más reciente o menos archivos. No se trunca.

El revisor recibe los datos por stdin. Antigravity usa el protocolo
stream-json comprobado en su CLI; los otros dos, texto. El catálogo valida
modelo y esfuerzo antes de invocar al revisor. El tiempo máximo es 15 minutos,
y stdout más stderr tienen un límite combinado de 16 MiB.

## Aislamiento, resultados y costes

La primera ejecución de cada versión y perfil comprueba el aislamiento en
carpetas temporales: tres llamadas (escritura dentro, fuera y shell), más una
consulta MCP de lectura para Antigravity. Estas llamadas adicionales consumen
tokens. Las instrucciones deben informar su número y alcance antes de consumo
fuera de lo autorizado. La evidencia se guarda en `~/.nexakit/revisores.json`
con el bloqueo limitado a leer y publicar el registro; las llamadas al modelo se hacen fuera de él. Se reutilizan resultados aprobados y fallidos para el mismo cliente,
versión, plataforma, argumentos y huellas de los ajustes de permisos. No se leen archivos de autenticación ni se guardan los contenidos de esos ajustes. Una CLI no verificable se rechaza.

Las pruebas requieren denegaciones de herramienta, no el relato del modelo.
Codex puede omitir las ejecuciones en stdout: se consulta el rollout de su
mismo thread id y originator `codex_exec`. Antigravity headless termina tras
la primera denegación; por eso se prueban acciones separadas. Las denegaciones
no son informes de revisión. Un informe vacío o con espacios produce fallo.

Antes y después se compara el disco. Se observa HEAD, estado Git, índice y
refs. Los archivos no ignorados se comparan por SHA-256, tamaño y fecha; los
ignorados, por tamaño y fecha. En node_modules solo se listan nombres y tamaños
del primer nivel. No se siguen enlaces exteriores. Si aparece una escritura,
se devuelve código 1 con las rutas y no se restaura nada. Los efectos externos,
las escrituras fuera del repositorio y los cambios deshechos antes de terminar
quedan fuera de esta comprobación.

Codex usa `--disable apps`; los perfiles de Claude deshabilitan MCP y las
herramientas de escritura indicadas. Las certificaciones observadas dependen
de los permisos locales cargados, especialmente en Antigravity: no son una
sandbox del sistema que garantice efectos externos. No conceder permisos de
escritura adicionales al revisor. Véase [la evidencia](fase-4-aislamiento.md).

El resultado muestra modelo pedido frente al informado y la fuente de este
último. Un dato ausente dice «no informado»; no se infieren esfuerzo ni tokens.
Una discrepancia de modelo o esfuerzo se marca con `!`. Los problemas graves
sin resolver deben aparecer en el resumen del principal, sin aprobación falsa.

## Instrucciones y mod opcional

El asistente anuncia «Reglas de trabajo en tus instrucciones de Claude Code,
Codex…» en la confirmación. Instala los bloques en `~/.claude/CLAUDE.md`,
`~/.codex/AGENTS.md` (respetando CODEX_HOME) y `~/.gemini/GEMINI.md`, según las
IA elegidas. Conserva el contenido del usuario y guarda la prueba de propiedad
en `~/.nexakit/review-instructions.json`; no escribe las reglas en el proyecto. La retirada borra solo el bloque cuyo hash acredita el registro;
las reglas editadas se conservan. Solo se modifican esos archivos de instrucciones tras la confirmación. Los ajustes, credenciales y permisos de las IA no se reescriben. Las instrucciones globales se retiran únicamente con la retirada global (`quitar --global --apply`); quitar un proyecto no retira reglas compartidas. Las skills antiguas registradas se retiran;
los conflictos ajenos y MCP/agentes obsoletos se informan para acción manual.

El mod opcional `nexakit-modelo` muestra modelo y esfuerzo observado frente a
la recomendación. No realiza revisiones ni cambia ajustes. Usa los eventos de
la API de mods, independientes de la revisión automática por instrucciones.
La CLI 2.1.316 valida el módulo y ejecuta sus pruebas sin llamadas de modelo.
Sin esfuerzo observado muestra «esfuerzo no informado», nunca ✓; al terminar
el turno descarta ese esfuerzo para no presentar el del turno anterior como
actual. No se instala globalmente de forma automática.

Fuentes de la API: [referencia oficial de mods](https://code.claude.com/docs/en/plugins/mods/reference)
y [registro de herramientas](https://code.claude.com/docs/en/plugins/mods/api).
