# Fuentes de las skills

Registro de los enlaces de origen de las skills y bibliotecas que utilizamos o
adaptamos para Agent Toolkit. Se amplía conforme incorporemos nuevas fuentes.

## Registro

| Skill o biblioteca | Origen | Relación con Agent Toolkit | Fecha de consulta |
| --- | --- | --- | --- |
| Superpowers | [Repositorio original: obra/superpowers](https://github.com/obra/superpowers) | El plugin original puede seguir instalado. Se adaptaron prácticas seleccionadas (`7.0.1`, MIT) en `spec-driven-development`, `depurar`, `desarrollo-con-pruebas` y `quality-gate`; ver [guía de integración](superpowers-integration.md). | 2026-10-31 |
| ordenar-proyecto | [Fuente local de Agent Toolkit](../../skills/ordenar-proyecto/SKILL.md) | Skill propia para organizar archivos y mantener referencias. Incorporada a la biblioteca; sin URL publicada independiente. | 2026-10-28 |
| Impeccable | [Repositorio original: pbakaus/impeccable](https://github.com/pbakaus/impeccable) | Disponible en el entorno local; no distribuida por Toolkit. | 2026-10-28 |
| frontend-design | [Claude Code Templates: creative-design/frontend-design](https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/skills/creative-design/frontend-design) | Incorporada sin modificar a skills/frontend-design y enlazada para Claude y Codex en este proyecto. | 2026-10-28 |
| web-design-guidelines | [Vercel: Web Design Guidelines](https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines) | Incorporada sin modificar y enlazada para Claude y Codex en este proyecto. | 2026-10-28 |
| mcp-builder | [Anthropic](https://github.com/anthropics/skills/tree/b9e19e6f44773509fbdd7001d77ff41a49a486c1/skills/mcp-builder) | Incorporada con recursos originales y licencia Apache-2.0; enlazada para ambos clientes. | 2026-10-28 |
| differential-review | [Trail of Bits](https://github.com/trailofbits/skills/tree/123037ec8aed26f0d86327cc39137ee5043e5deb/plugins/differential-review/skills/differential-review) | Incorporada con referencias originales y licencia CC BY-SA 4.0; enlazada para ambos clientes. | 2026-10-28 |
| ui-ux-pro-max | [Next Level Builder (`713eef51b04efc98d6fa565323b495f7c9c89fd4`)](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/tree/713eef51b04efc98d6fa565323b495f7c9c89fd4/.claude/skills/ui-ux-pro-max) | Referencia externa en `externalReferences` (MIT): se sugiere en proyectos de frontend y se instala como plugin de Claude. No se copia porque `google-fonts.csv` supera 512 KiB y sus órdenes dependen de `CLAUDE_PLUGIN_ROOT`. Escaneo sin bloqueos; no probada. | 2026-11-02 |

## MCP Builder y revisión de seguridad

Instaladas el 2026-10-28 mediante skill-installer desde revisiones fijadas. La
copia canónica de cada una vive en skills/; las rutas de proyecto .agents/skills
y .claude/skills apuntan por enlaces relativos a esa misma copia.

- [MCP Builder](../../skills/mcp-builder/SKILL.md),
  [licencia original](../../skills/mcp-builder/LICENSE.txt).
- [Differential Review](../../skills/differential-review/SKILL.md),
  [licencia del repositorio fuente conservada](../../skills/differential-review/LICENSE.txt).
- [Manifiesto de archivos y hashes](evidencias/2026-10-28-incorporacion-mcp-seguridad.json).
- [Revisión inicial, pruebas y límites](evidencias/2026-10-28-evaluacion-inicial-mcp-seguridad.md).

MCP Builder incluye un evaluador opcional que usa la API de Anthropic. Las
referencias de Differential Review mencionan herramientas y agentes del plugin
completo que no se incorporan al instalar solo esta skill. La evaluación local
se delimitó expresamente y no ejecutó esos componentes externos.

## Web Design Guidelines — Vercel

- [Fuente exacta revisada](https://github.com/vercel-labs/agent-skills/tree/ba46938889d4e58635362fb8f618e1178ac3ec46/skills/web-design-guidelines).
- [Skill incorporada](../../skills/web-design-guidelines/SKILL.md).
- [Guía de interfaz que consulta durante sus revisiones](https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md).

Instalada el 2026-10-28 con skill-installer desde vercel-labs/agent-skills,
ruta skills/web-design-guidelines, revisión
`ba46938889d4e58635362fb8f618e1178ac3ec46`. Declara versión 1.0.0.

La copia canónica vive en skills/web-design-guidelines. Los enlaces relativos
.claude/skills/web-design-guidelines y .agents/skills/web-design-guidelines
apuntan a esa carpeta para este proyecto. La comprobación acredita archivos y
enlaces, no la carga de la skill en una sesión abierta.

La skill se conserva sin cambios y su SHA-256 es
`f4647ca866a3accf763777f83e7682954f0187cd6bea7eea0399796652414e8f`.
El [README de la revisión fuente declara MIT](https://github.com/vercel-labs/agent-skills/blob/ba46938889d4e58635362fb8f618e1178ac3ec46/README.md#license);
la carpeta de la skill consultada contiene únicamente SKILL.md y no incluye
un archivo de licencia independiente.

La revisión fijada corresponde a la skill. Sus instrucciones consultan las
reglas de interfaz vigentes por internet antes de cada revisión; esas reglas
externas pueden cambiar y no quedan fijadas por el hash de SKILL.md.

## Frontend Design — Claude Code Templates

- [Página del componente](https://www.aitmpl.com/component/skill/creative-design/frontend-design).
- [Fuente exacta revisada](https://github.com/davila7/claude-code-templates/tree/7faa175714982142b40bceb2b5de881e3c93a778/cli-tool/components/skills/creative-design/frontend-design).
- [Skill incorporada](../../skills/frontend-design/SKILL.md) y
  [licencia Apache-2.0 original](../../skills/frontend-design/LICENSE.txt).

Instalada el 2026-10-28 desde el componente solicitado por el usuario:

```sh
npx claude-code-templates@latest --skill creative-design/frontend-design
```

En esta instalación, latest resolvió a la versión 1.30.0 del instalador. El
contenido se comprobó contra la revisión
`7faa175714982142b40bceb2b5de881e3c93a778` del repositorio fuente.

La copia canónica vive en skills/frontend-design. Los enlaces relativos
.claude/skills/frontend-design y .agents/skills/frontend-design apuntan a esa
misma carpeta para el uso en este proyecto. La comprobación acredita archivos y
enlaces; no certifica que una sesión abierta haya cargado ya la skill.

SHA-256 de los archivos originales, conservados sin editar:

- SKILL.md: `d91970639e9f5c37682ac7ab60094d35f1c7c1f38d731bd56396563aee10c1d3`.
- LICENSE.txt: `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594`.

Observación del instalador: su invocación con --dry-run --yes escribió los dos
archivos y reportó la instalación completada. Se inspeccionaron y verificaron
esos archivos y no se repitió la instalación. Este comportamiento observado no
debe tomarse como una vista previa sin escritura.

## Candidatas investigadas

Como referencia para un futuro recomendador se investigó
[AutoSkills de midudev](https://github.com/midudev/autoskills) el 2026-10-28.
Es una herramienta de detección e instalación con un catálogo mantenido por
sus autores; no es una skill incorporada a Toolkit ni se instaló en esta tarea.
La evaluación está en [Skills recomendadas](skills-recomendadas.md#referente-para-un-recomendador-autoskills).

Estas fuentes están registradas para evaluación. Los motivos y prioridades están
en [Skills recomendadas](skills-recomendadas.md).

| Skill | Fuente original fijada | Estado en Agent Toolkit | Fecha |
| --- | --- | --- | --- |
| vercel-react-best-practices | [Vercel (`1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62`)](https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/react-best-practices) | Incorporada en `catalogs/skills/vercel-react-best-practices` (MIT) con hashes SHA-256 en `catalogs/skills.json`. | 2026-10-31 |
| vercel-composition-patterns | [Vercel (`1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62`)](https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/composition-patterns) | Incorporada en `catalogs/skills/vercel-composition-patterns` (MIT) con hashes SHA-256 en `catalogs/skills.json`. | 2026-10-31 |
| supabase-postgres-best-practices | [Supabase (`c9be0e931b7930f7d02126d04774d904c381e7d7`)](https://github.com/supabase/agent-skills/tree/c9be0e931b7930f7d02126d04774d904c381e7d7/skills/supabase-postgres-best-practices) | Incorporada en `catalogs/skills/supabase-postgres-best-practices` con `LICENSE.txt` MIT original y hashes SHA-256. | 2026-10-31 |
| nodejs-backend-patterns | [wshobson/agents (`7e2fb559cf4b824b27f1fec49fe88f7511066d26`)](https://github.com/wshobson/agents/tree/7e2fb559cf4b824b27f1fec49fe88f7511066d26/plugins/javascript-typescript/skills/nodejs-backend-patterns) | Incorporada en `catalogs/skills/nodejs-backend-patterns` con `LICENSE.txt` MIT original y hashes SHA-256. | 2026-10-31 |
| api-design-principles | [wshobson/agents (`7e2fb559cf4b824b27f1fec49fe88f7511066d26`)](https://github.com/wshobson/agents/tree/7e2fb559cf4b824b27f1fec49fe88f7511066d26/plugins/backend-development/skills/api-design-principles) | Incorporada en `catalogs/skills/api-design-principles` con `LICENSE.txt` MIT original y hashes SHA-256. | 2026-10-31 |
| webapp-testing | [Anthropic (`ca45fc496a3436251f191354091d557da31c15b5`)](https://github.com/anthropics/skills/tree/ca45fc496a3436251f191354091d557da31c15b5/skills/webapp-testing) | Incorporada en `catalogs/skills/webapp-testing` con `LICENSE.txt` Apache-2.0 original y hashes SHA-256. | 2026-10-31 |

## Superpowers

- [Repositorio original](https://github.com/obra/superpowers).
- [Carpeta de skills](https://github.com/obra/superpowers/tree/main/skills).
- [Documentación e instalación](https://github.com/obra/superpowers#installation).
- [Licencia MIT](https://github.com/obra/superpowers/blob/main/LICENSE).

La instalación local consultada corresponde a Superpowers **7.0.1** (`Copyright (c) 2025 Jesse Vincent`, licencia MIT). Ese dato
identifica la copia revisada; los enlaces a `main` muestran el contenido vigente
del repositorio y pueden cambiar.

La [guía de integración y adaptación](superpowers-integration.md) relaciona cada
práctica revisada (`using-superpowers`, `brainstorming`, `writing-plans`,
`systematic-debugging`, `test-driven-development` y `verification-before-completion`)
con las skills [`spec-driven-development`](../../skills/spec-driven-development/SKILL.md),
[`depurar`](../../skills/depurar/SKILL.md),
[`desarrollo-con-pruebas`](../../skills/desarrollo-con-pruebas/SKILL.md) y
[`quality-gate`](../../skills/quality-gate/SKILL.md), cada una con su copia de
`LICENSE.txt` original. El diseño de adaptación (en la memoria de Obsidian de NexaKit (`03-IMPLEMENTACION/Planes/2026-10-28-integracion-superpowers-design.md`)
conserva las decisiones de alcance. El plugin original y las adaptaciones de
Toolkit mantienen mantenimiento separado.

## Cómo ampliar el registro

Para cada nueva fuente, anotar nombre, URL original verificada, uso en Toolkit y
fecha de consulta. Añadir versión o revisión cuando se adapte contenido concreto,
junto con su licencia y atribución. Si un origen está pendiente de confirmar,
marcarlo como pendiente en vez de deducir una URL.

Para incorporar los archivos y reglas de una skill al catálogo, generar su inventario SHA-256 y registrar escenarios de utilidad, sigue [Añadir y validar skills del catálogo](ampliar-catalogo.md).
