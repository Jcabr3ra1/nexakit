---
name: web-design-guidelines
license: Reglas de Vercel Labs con licencia MIT en LICENSE.txt; estas instrucciones, MIT de nexakit
description: Revisa código de interfaz web contra las Web Interface Guidelines (accesibilidad, foco, formularios, animación, tipografía, rendimiento y tema oscuro). Úsala cuando pidan revisar la UI, la accesibilidad o la UX, o auditar una página contra buenas prácticas.
---

# Pautas de interfaz web

Revisa archivos de interfaz contra las reglas de [`AGENTS.md`](AGENTS.md): las Web Interface Guidelines de
Vercel Labs, copiadas tal cual del commit `434b7f9` de
[vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines) con su
licencia MIT en [`LICENSE.txt`](LICENSE.txt). Las reglas están fijadas en esta carpeta: no se descargan
en cada revisión.

## Cómo revisar

1. Si no te dicen qué revisar, pregunta por los archivos o el patrón (por ejemplo `src/**/*.tsx`).
2. Lee `AGENTS.md` completo y los archivos indicados.
3. Comprueba cada archivo contra las reglas. `MUST` y `NEVER` son obligatorias; `SHOULD`, recomendaciones.
4. Informa cada hallazgo en una línea: `archivo:línea — regla — qué cambiar`. Agrupa por archivo y ordena
   primero los `MUST`/`NEVER`.
5. Si un archivo cumple, dilo en una línea; no inventes hallazgos para llenar el informe.

## Límites

- Es una revisión estática del código: no sustituye probar con teclado, lector de pantalla o en un móvil real.
  Dilo al final del informe.
- Algunas reglas son de React/Next.js; en otros frameworks aplica su equivalente o márcalas como no aplicables.
- Para diseñar o rediseñar, usa `frontend-design`; esta skill revisa lo que ya existe.
