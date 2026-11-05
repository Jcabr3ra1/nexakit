# Superpowers en nexakit

[obra/superpowers](https://github.com/obra/superpowers) es **obligatorio** en nexakit: lleva el proceso de trabajo
de las tres IA (Claude Code, Codex y Antigravity). nexakit no copia sus skills; las instala desde el gestor de
plugins de cada IA y añade encima las reglas y la puerta de calidad propias.

## Cómo se instala

`npx nexakit` comprueba Superpowers en cada IA elegida y, si falta, lo instala con la orden de esa IA:

| IA | Orden | Marketplace revisado |
| --- | --- | --- |
| Claude Code | `claude plugin install superpowers@claude-plugins-official` | Oficial de Anthropic |
| Codex | `codex plugin add superpowers@openai-curated-remote` | Catálogo curado de OpenAI |
| Antigravity | `agy plugin install superpowers@antigravity-plugins-partners` | Socios de Antigravity |

- Si está **desactivado**, `npx nexakit` lo activa en Claude Code y Antigravity. Codex no tiene orden para activar
  plugins: nexakit avisa y se activa desde Codex (`/plugins`).
- Si la lista de plugins **no se puede leer**, nexakit avisa y no instala nada encima.
- `nexakit comprobar` y `doctor` muestran el estado por IA (`activo`, `desactivado`, `falta` o `desconocido`) y
  fallan si falta o está desactivado.
- Hay que reiniciar la IA para que cargue el plugin recién instalado.

## Qué hace cada parte

| Etapa | Skill | De dónde |
| --- | --- | --- |
| Diseñar | `brainstorming` | Superpowers |
| Planificar | `writing-plans`, `executing-plans`, `subagent-driven-development` | Superpowers |
| Diagnosticar | `systematic-debugging` | Superpowers |
| Programar con pruebas | `test-driven-development` | Superpowers |
| Afirmar que algo funciona | `verification-before-completion` | Superpowers |
| Puerta antes de PR o revisión | [`quality-gate`](../../skills/quality-gate/SKILL.md) | nexakit: requisitos uno por uno, seguridad, diff delegado y dictamen, sobre la evidencia de Superpowers |
| Revisión por otra IA | [`revisar`](../../skills/revisar/SKILL.md), [`revision-cruzada`](../../skills/revision-cruzada/SKILL.md) y plugin `niveles` | nexakit |
| Cierre y traspaso | [`cerrar-memoria`](../../skills/cerrar-memoria/SKILL.md), [`project-handoff`](../../skills/project-handoff/SKILL.md) | nexakit |

En Claude Code y Codex las skills se llaman con el prefijo del plugin (`superpowers:brainstorming`); en Antigravity,
por su nombre (`brainstorming`). `using-superpowers` las activa solas cuando aplican.

## Reglas que mandan sobre Superpowers

Superpowers da prioridad a las instrucciones del usuario sobre sus skills. nexakit escribe estas reglas en el bloque
de instrucciones de cada IA (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`):

1. **Modo `tutor`:** la persona escribe el código; el agente avanza un paso verificable cada vez.
2. **Nunca destruir trabajo:** no se borra ni descarta código existente sin acuerdo, aunque el TDD estricto lo pida.
3. **Permisos:** commit, push, PR y cambios en la memoria solo con autorización explícita.
4. **Un único flujo:** si ya hay un diseño o plan aprobado para el objetivo, se reutiliza.
5. **Puerta propia:** antes de un PR o de la revisión cruzada se pasa `quality-gate`.

## Skills retiradas

Hasta la versión con Superpowers obligatorio, nexakit traía adaptaciones al español de cuatro prácticas de
Superpowers 7.0.1. Tres eran copias directas y se retiraron; `setup` quita los enlaces que nexakit creó y avisa si
hay una carpeta ajena con el mismo nombre:

| Retirada | La sustituye |
| --- | --- |
| `spec-driven-development` | `brainstorming` y `writing-plans` |
| `depurar` | `systematic-debugging` |
| `desarrollo-con-pruebas` | `test-driven-development` |

`quality-gate` se mantiene: solo tomaba de Superpowers la regla de evidencia fresca y el resto es propio.

## Atribución y licencia

Superpowers es de **Jesse Vincent**, con **licencia MIT** (`Copyright (c) 2025 Jesse Vincent`). `quality-gate`
conserva una adaptación parcial de `verification-before-completion` y su aviso MIT en
[`skills/quality-gate/LICENSE.txt`](../../skills/quality-gate/LICENSE.txt). Consulta también el
[registro de fuentes de las skills](fuentes-de-skills.md#superpowers).
