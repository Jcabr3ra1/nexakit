# Asistente por pasos y recomendador de skills

Agent Toolkit incluye un asistente interactivo en terminal por pasos (inspirado en flujos tipo `autoskills` / `clack`, con motor y catálogo propios sobre Node.js 24) y un subcomando en solo lectura para detectar el stack de un proyecto e instalar skills verificadas con hashes SHA-256.

## Uso rápido

```sh
# Abrir el asistente guiado por pasos en el proyecto actual (requiere terminal TTY)
npx nexakit
npx nexakit tui --project /ruta/al/proyecto

# Consultar recomendaciones en solo lectura (texto o JSON)
npx nexakit recommend --project /ruta/al/proyecto
npx nexakit recommend --project /ruta/al/proyecto --dry-run --json

# Desacoplar NexaKit del proyecto (vista previa segura primero, --apply para ejecutar)
npx nexakit detach --project /ruta/al/proyecto
npx nexakit detach --project /ruta/al/proyecto --apply
```
*(También puedes usar `node bin/nexakit.js` o el alias local `agent-toolkit`).*

## Flujo del asistente en 3 pasos (`agent-toolkit`)

1. **Skills para tu proyecto:** muestra las skills que encajan con las tecnologías observadas en `package.json` / `tsconfig.json`, con el motivo y la utilidad prevista de cada sugerencia. Solo se premarcan las recomendaciones con escenario validado para todos los agentes destino, cuando requieren instalación; las compatibles sin prueba quedan desmarcadas. Usa `Espacio` para marcar o desmarcar y `Enter` para avanzar.
2. **Skills opcionales:** muestra las demás skills verificadas del catálogo, desmarcadas por defecto, y los complementos externos. [obra/superpowers](superpowers-integration.md) (`7.0.1`, MIT) no es opcional: `npx nexakit` lo instala en cada IA.
3. **Revisar e instalar:** muestra las skills elegidas y su configuración, comprueba los hashes SHA-256 contra [`catalogs/skills.json`](../../catalogs/skills.json) y lista enlaces, copias, registros y reglas de ignore antes de escribir. `Enter` / `s` confirma; `Esc` / `n` cancela sin escribir; `Bksp` / `←` vuelve a opcionales conservando las marcas.

### Configuración de instalación

En el tercer paso, pulsa **`e`** para editar estos ajustes dentro de la revisión:

- **Agentes destino:** Claude + Codex (por defecto), solo Claude o solo Codex.
- **Enlace simbólico (por defecto):** enlaza `.agents/skills/<skill>` y `.claude/skills/<skill>` hacia la copia verificada de Agent Toolkit.
- **Copia verificada:** comprueba SHA-256, copia las skills al proyecto y guarda el manifiesto y `.agent-toolkit/skills-lock.json`.
- **Ignorar en Git:** bloque delimitado gestionado en `.gitignore` (por defecto) o en `.git/info/exclude`, sin modificar el ignore compartido del equipo.
- **Núcleo global:** sincronización opcional de las skills base y agentes de nivel de tu usuario.

Dentro del editor, `↑` / `↓` selecciona el ajuste y `Espacio` cambia el valor o la casilla. **`Enter` actualiza la vista previa, sin instalar**; debes confirmar después desde la revisión. **`Esc` / `Bksp` descarta el borrador** y recupera la configuración anterior. Cambiar el agente o el modo conserva las skills marcadas y recalcula sus estados antes de permitir instalar.

Los conflictos se conservan sin sobrescribir archivos propios. La guía de comandos está disponible con `c` en cualquier paso, incluido el editor.

## Desacoplado limpio del proyecto (`[d]` o `agent-toolkit detach`)

Cuando quieras retirar Agent Toolkit de un proyecto sin dejar rastro en Git ni en el árbol de trabajo:

- **Desde el asistente interactivo:** pulsa **`[d]`** en cualquier paso para abrir la vista previa segura de desacoplado y confirma con `Enter` / `s` (o cancela con `Esc` sin borrar nada).
- **Desde terminal:** ejecuta `agent-toolkit detach --project <ruta>` para revisar qué se retiraría y añade `--apply` para aplicarlo (`--global` retira además los enlaces globales en `~/.claude` / `~/.agents` y los `nivel_*.toml` generados en `~/.codex/agents`).
- **Garantías de seguridad:** elimina únicamente los enlaces creados hacia Agent Toolkit o las copias cuyos archivos coinciden por `SHA-256` con el catálogo, retira `.agent-toolkit/`, limpia el bloque gestionado en `.gitignore` / `.git/info/exclude` y poda carpetas vacías (`.agents/skills`, `.claude/skills`), conservando intacta cualquier skill propia o archivo editado por el usuario.

## Catálogo curado de 10 skills verificadas

El catálogo vive en [`catalogs/skills.json`](../../catalogs/skills.json) y se valida con [`schemas/skill-catalog.schema.json`](../../schemas/skill-catalog.schema.json) mediante [`src/skill-catalog.js`](../../src/skill-catalog.js). Las skills específicas de stack residen en `catalogs/skills/` para no contaminar las carpetas globales de proyectos que no usan esas tecnologías:

- **Frontend / React / Next.js:** `vercel-react-best-practices` (MIT), `vercel-composition-patterns` (MIT), `frontend-design` (Apache-2.0), `web-design-guidelines` (MIT), `webapp-testing` (Apache-2.0).
- **Bases de datos:** `supabase-postgres-best-practices` (MIT).
- **Backend Node.js y APIs:** `nodejs-backend-patterns` (MIT), `api-design-principles` (MIT).
- **Servidores MCP y seguridad transversal:** `mcp-builder` (Apache-2.0), `differential-review` (CC-BY-SA-4.0).

## Sugerencias y ampliación del catálogo

Coincidir con una tecnología o un perfil genera una skill compatible, no una recomendación de utilidad probada. La ayuda muestra el archivo/dependencia que la justifica, su utilidad prevista, lo pendiente y los solapamientos. SHA-256 se presenta por separado como comprobación de integridad.

Actualmente las entradas del catálogo no tienen escenarios funcionales pasados; por eso las compatibles se eligen manualmente. Las elecciones manuales se conservan al cambiar destino; las selecciones automáticas se recalculan según la evidencia del agente elegido.

Para incorporar nuevas skills, generar el inventario de archivos y comprobar el catálogo, consulta [Añadir y validar skills](ampliar-catalogo.md).
