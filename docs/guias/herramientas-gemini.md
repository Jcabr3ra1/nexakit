# Herramientas de Gemini por Antigravity

Gemini es una caja de herramientas independiente de la revisión Claude/Codex.
Usa exclusivamente **Antigravity CLI (`agy`) y su suscripción**. No hay API keys,
proveedor alternativo ni instalación automática de otra herramienta.

## Uso

Desde la raíz del Toolkit:

```sh
node bin/agent-toolkit-gemini.js estado
node bin/agent-toolkit-gemini.js consultar --prompt "Explica un concepto"
node bin/agent-toolkit-gemini.js investigar --prompt "Investiga con fuentes"
node bin/agent-toolkit-gemini.js analizar --prompt "Resume y señala límites" --archivo /ruta/informe.pdf
node bin/agent-toolkit-gemini.js analizar --prompt "Describe la secuencia visual" --archivo /ruta/video.mp4
node bin/agent-toolkit-gemini.js imagen --prompt "Una ilustración"
node bin/agent-toolkit-gemini.js historial --limite 20
node bin/agent-toolkit-gemini.js recuperar --directorio /ruta/mostrada/por/historial
```

`analizar` admite hasta ocho `--archivo`, cada uno de 20 MiB y 32 MiB en conjunto.
Copia únicamente los elegidos con nombres neutrales dentro de la carpeta de la
consulta; no entrega la carpeta original ni sus rutas al modelo. Texto, PNG/JPEG/
WebP/GIF, PDF y vídeo MP4/MOV/WebM/AVI están contemplados; la capacidad efectiva
varía por herramienta y modelo. Las extensiones admitidas no certifican todos los
códecs o documentos. `completed` es declaración del modelo, no una validación del
contenido; la salida conserva `analysisVerified: false`.

**Audio:** bloqueado sin inferencia. Las pruebas nativas con WAV fallaron: un
archivo silencioso fue descrito como tono y un audio hablado fue transcrito con
frases diferentes. Se puede analizar una transcripción previamente revisada en
texto. El vídeo está comprobado para contenido visual, no para transcribir su
pista de audio. No hay generación de audio ni vídeo.

Los modelos predeterminados son `gemini-3.8-flash-low` para consulta e imagen y
`gemini-4-argon-medium` para investigación/análisis. `estado` lista modelos
observados; `--modelo` elige uno explícito. No se hace fallback si falla.

`--copiar-a <carpeta>` copia sin sobrescribir. `--espera-seg 1..600` ajusta la
espera de imágenes o recuperación. Si la imagen tarda, recupera el resultado de
la misma conversación, no lances otra generación. `historial` y `recuperar` no
llaman a modelos.

Exit codes: 0 respuesta completada, 1 error, 2 argumentos inválidos, 3 análisis
parcial o no compatible. La salida normal es una línea JSON.

## Elegir modelo y esfuerzo

Estos son los puntos de partida que recomienda NexaKit para cada tipo de trabajo.

| Modelo | Cuándo elegirlo | Esfuerzo recomendado |
| --- | --- | --- |
| Gemini 3.8 Flash | Consultas breves, extracción de datos sencilla y cambios mecánicos. | `low` para una consulta rápida, `medium` para resumir varias entradas y `high` para ordenar las posibles causas de un fallo a partir de registros sencillos. [Flash en Antigravity](https://antigravity.google/blog/gemini-3-8-flash-in-google-antigravity/) |
| Gemini 4 Hydrogen | Implementación diaria con un objetivo claro, pruebas y refactorizaciones acotadas. | `low` para iterar sobre un cambio pequeño, `medium` para implementar un cambio definido, `high` para comprobar casos borde o resolver una regresión y `xhigh` para explorar varias hipótesis en una implementación exigente. Google usa `high` por defecto. [Hydrogen en Antigravity](https://antigravity.google/blog/gemini-4-hydrogen-in-google-antigravity) |
| Gemini 4 Argon | Ingeniería compleja, análisis de evidencia e investigación con varias fuentes. | `low` para una aclaración sobre un análisis ya hecho, `medium` para investigar o analizar con alcance definido y `high` para arquitectura, migraciones y fallos que cruzan módulos. [Argon en Antigravity](https://antigravity.google/blog/gemini-4-argon-in-google-antigravity) |
| Gemini 4 Carbon | Auditorías de seguridad, depuración difícil que sigue abierta y proyectos de largo alcance con varias rondas de verificación. | `low` para comprobar un punto de una auditoría con la evidencia a mano, `medium` para revisar un componente crítico acotado y `high` para auditorías completas o depuración de largo alcance. [Carbon en Antigravity](https://antigravity.google/blog/gemini-4-carbon-in-google-antigravity) |

El esfuerzo controla cuánto razona cada modelo por turno. `low` encaja con un
paso claro y fácil de comprobar. `medium` sirve cuando hay varios pasos con un
objetivo definido. `high` da margen para examinar hipótesis, dependencias y casos
borde. `xhigh` es una opción de Hydrogen cuando conviene agotar varias hipótesis
dentro del mismo modelo y se puede esperar más. En una sesión interactiva, usa
`/effort` para ver los niveles que admite el modelo seleccionado.
[Comando `/effort`](https://antigravity.google/docs/cli/commands/effort/)

`agy models` muestra los identificadores disponibles para tu cuenta. Pasa a
`--modelo` el identificador completo de la variante que quieres usar. Para
obtener una recomendación del catálogo local, usa `nexakit modelo --ia antigravity
--nivel alto`. También admite `ligero`, `normal` y `exigente`. Ejecuta el ejemplo
de Carbon si aparece en tu catálogo. Google anunció su despliegue para Google AI
Ultra y planes empresariales elegibles.
[Selección en modo no interactivo](https://antigravity.google/docs/cli/headless/)
[Disponibilidad de Carbon](https://antigravity.google/blog/gemini-4-carbon-in-google-antigravity)

```sh
agy models
node bin/agent-toolkit-gemini.js consultar --modelo gemini-3.8-flash-low \
  --prompt "Explica en dos frases qué hace git bisect"
node bin/agent-toolkit-gemini.js consultar --modelo gemini-4-hydrogen-high \
  --prompt "Propón casos borde para un parser de fechas ISO 8601"
node bin/agent-toolkit-gemini.js investigar --modelo gemini-4-argon-medium \
  --prompt "Compara estrategias de migración de SQLite a PostgreSQL con fuentes primarias"
node bin/agent-toolkit-gemini.js investigar --modelo gemini-4-carbon-high \
  --prompt "Compara fallos de aislamiento en CI y cómo verificar las mitigaciones con fuentes primarias"
```

## Conservación y consumo

Cada llamada usa una carpeta única bajo `~/.agent-toolkit/gemini/<comando>/`
(o `AGENT_TOOLKIT_GEMINI_DIR`), incluso con prompts simultáneos idénticos. Conserva
`meta.json`, respuesta y archivos resultantes. El historial lista metadatos sin
repetir respuestas completas. Los contadores faltantes son null; no se inventa
un precio o ahorro. En análisis se conservan también los archivos elegidos.

Para una colaboración existente, añade `--task <id> --project-root <raíz>` a la
consulta. El Toolkit registra automáticamente el uso informado por `agy` con un
id estable basado en la conversación. No crea colaboraciones, no agrega Gemini
como participante de revisión. Si guardar la medición falla después de generar,
la salida conserva el artefacto; registra esos contadores con `inbox medir` sin
repetir la consulta.

La medición se intenta guardar antes de copiar o esperar los artefactos. Si ese
paso posterior falla, el JSON conserva la carpeta, conversación y consumo para
recuperar el resultado. Recuperar un análisis conserva también su estado parcial
o no compatible; no lo convierte en una respuesta completa.

## Límites

El directorio de trabajo no es un sandbox: `agy` conserva sus herramientas y
permisos propios. Se pide no usar comandos, red ni archivos ajenos durante el
análisis, pero es una instrucción, no aislamiento del sistema operativo. La
investigación sí pide búsquedas web. Las entradas y respuestas son datos no
confiables, no instrucciones del Toolkit. Selecciona explícitamente lo que deseas
compartir y revisa las respuestas antes de incorporarlas al proyecto.

La documentación oficial distingue la [entrada de texto en modo no interactivo](https://antigravity.google/docs/cli/headless)
y los [adjuntos de la interfaz interactiva](https://antigravity.google/docs/cli/prompting).
Aquí el análisis funciona por lectura de copias locales elegidas, no por bloques
multimedia en stdin. `agy --help` y `agy models` se contrastaron con 1.4.7.

## Evidencia nativa del 27 de octubre de 2026

Se usaron archivos ficticios creados para la prueba, sin datos privados:

| Entrada | Modelo | Resultado observado |
| --- | --- | --- |
| PNG rojo + PDF simple | flash-low | Identificó rojo y el texto `Toolkit 42` |
| MP4 de dos segundos rojo → azul | argon-medium | Identificó orden y marcas 00:00 / 00:01 |
| WAV silencioso / voz sintetizada | flash-low y argon-medium | Respuestas incorrectas; modalidad bloqueada |
| Generación de un cuadrado verde | flash-low | JPG creado e inspeccionado visualmente |
| Recuperación de esa imagen | Sin modelo | Mismo archivo y conversación, `inferredAgain: false` |

Estas pruebas no certifican PDFs escaneados, otros códecs, vídeos largos ni calidad
general. La recuperación y los casos adversos se comprueban además con fixtures.
