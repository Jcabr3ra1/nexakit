# Guía de NexaKit

NexaKit conecta Claude Code y Codex: una terminal programa, la otra revisa y tú apruebas cada paso. Esta referencia parte de cero, justo después de clonar el repositorio. Para seguir el inicio, crear una memoria y abrirla en Obsidian, usa la [guía interactiva con comandos copiables](guia-de-comandos.html); abre ese archivo HTML en tu navegador.

| Para | Escribe | Dónde |
| --- | --- | --- |
| Programar | `/programar <tarea>` | en Claude (o `$programar` en Codex) |
| Revisar | `$revisar` | en Codex (o `/revisar` en Claude) |
| Ver cómo va | `/estado` en Claude, `$estado` en Codex | en el chat del agente |
| Cerrar el PR | `/cerrar-memoria` | si el proyecto tiene memoria |

En Claude Code las skills empiezan con `/`. En Codex, con `$`. Los comandos de terminal se ejecutan desde la carpeta donde clonaste el repositorio.

## Antes de empezar

| Herramienta | Para qué | Comprueba con |
| --- | --- | --- |
| Git | Clonar el repositorio | `git --version` |
| Node.js 24 | Ejecuta todos los comandos (la versión debe empezar por v24) | `node --version` |
| Claude Code | Una de las dos terminales | `claude --version` |
| Codex CLI | La otra terminal | `codex --version` |

Opcionales:

| Herramienta | Para qué | Comprueba con |
| --- | --- | --- |
| Antigravity CLI (agy) | Solo para la skill gemini (investigar, analizar, imágenes) | `agy --version` |
| GitHub CLI (gh) | Solo para actualizar la memoria con project-memory sync | `gh --version` |

Necesitas la sesión iniciada en Claude Code y en Codex. La revisión cruzada necesita los dos.

## Instalar (una sola vez)

### 1. Clona el repositorio donde quieras

```sh
git clone https://github.com/Jcabr3ra1/nexakit.git
cd nexakit
```

Cualquier carpeta sirve. Todos los comandos siguientes se ejecutan desde ella. No la borres ni la muevas después: las skills y el servidor apuntan ahí (si la mueves, repite los pasos 4 y 5).

### 2. Instala las dependencias y comprueba

```sh
npm ci --ignore-scripts
npm test
```

`npm test` tarda alrededor de un minuto y debe terminar sin fallos. Es opcional, pero confirma que tu Node y tu copia están bien.

### 3. Abre el asistente por pasos o revisa qué falta

En una terminal interactiva puedes abrir el asistente en tres pasos: skills para tu proyecto, opcionales y revisión de la instalación. Las compatibles se eligen manualmente; solo se premarcan recomendaciones con escenarios validados para los agentes destino. En la última pantalla, `e` permite cambiar agentes, modo, Git ignore y núcleo global. El estado del proyecto queda bajo `.agent-toolkit/`; `[d]` y `detach` permiten desacoplarlo con vista previa.

```sh
npx nexakit                                   # o node bin/nexakit.js (alias: agent-toolkit)
npx nexakit recommend --project .
npx nexakit scan ruta/a/una-skill              # revisa una skill sin ejecutarla
npx nexakit detach --project .                # vista previa de desacoplado
npx nexakit detach --project . --apply        # retira lo acoplado sin tocar archivos propios
```

Si prefieres ejecutar cada comprobación por separado o desde un script:

```sh
node bin/agent-toolkit.js doctor --agent all
```

Comprueba Node, dependencias, Claude Code, Codex, el servidor, las skills y el permiso de Codex. Al principio es normal que marque pendientes: los resuelven los pasos siguientes.

### 4. Enlaza las skills

```sh
node bin/agent-toolkit.js setup --agent all          # vista previa, no escribe
node bin/agent-toolkit.js setup --agent all --apply  # crea los enlaces
```

Enlaza las skills de esta carpeta en `~/.claude/skills` (Claude) y `~/.agents/skills` (Codex). Nunca reemplaza lo que ya existe: si hay un conflicto, lo indica y no toca nada.

### 5. Conecta el servidor en Claude Code y en Codex

```sh
claude mcp add --scope user --transport stdio agent-toolkit-workflow -- node "$PWD/bin/agent-toolkit-mcp.js"
codex mcp add agent-toolkit-workflow -- node "$PWD/bin/agent-toolkit-mcp.js"
```

Es el servidor que guarda las revisiones entre las dos terminales. `setup` imprime estos mismos comandos con tu ruta. Si ya existe uno con ese nombre, no lo repitas.

### 6. Deja que Codex guarde su registro de revisor

```sh
grep -q "^\[sandbox_workspace_write\]" ~/.codex/config.toml 2>/dev/null && echo "Ya tienes la sección: añade la ruta a writable_roots a mano" || printf "\n[sandbox_workspace_write]\nwritable_roots = [\"%s/.agent-toolkit\"]\n" "$HOME" >> ~/.codex/config.toml
```

Codex ejecuta sus comandos en un sandbox que solo deja escribir en el proyecto, y `$revisar` guarda el id de su sesión en `~/.agent-toolkit`. `doctor` te dice si falta este permiso e imprime el comando con tus rutas.

### 7. Instala el plugin de niveles (solo Claude Code)

```text
/plugin marketplace add Jcabr3ra1/nexakit
/plugin install niveles@agent-toolkit
```

Se escribe *dentro* de Claude Code, no en la terminal. Añade cuatro agentes con modelo y esfuerzo fijos para delegar trabajo sin cambiar `/model`.

### 8. Crea los agentes de nivel de Codex

```sh
node bin/agent-toolkit-inbox.js agentes            # vista previa, no escribe
node bin/agent-toolkit-inbox.js agentes --escribir # crea los que falten
```

Nunca sobrescribe ni borra. Si ya existe uno distinto lo respeta; con `--escribir --forzar` lo aparta como `.anterior-…` antes de crear el nuevo.

### 9. Reinicia Claude Code y Codex y vuelve a revisar

```sh
node bin/agent-toolkit.js doctor --agent all
```

Ambos cargan el servidor y las skills al arrancar. Ahora `doctor` no debe mostrar pendientes: termina con código 0.

Para actualizar más adelante: `git pull --ff-only` y `npm ci --ignore-scripts` dentro del repositorio, y reinicia Claude Code y Codex.

## Primer uso

1. **Tú:** Abre dos terminales en la carpeta de tu proyecto. Una con `claude` y otra con `codex`. Debe ser la **misma ruta** en las dos, y es el proyecto en el que vas a trabajar, no Agent Toolkit.
2. **Codex:** Escribe `$revisar`. Registra su sesión y dice «Registrada; me avisarán». Termina su turno y no gasta tokens esperando. Si no encuentra su sesión, pide el id: en Codex, `/status`.
3. **Claude:** Escribe `/programar <la tarea>`. Claude puntúa la tarea y elige un nivel (tabla de abajo).
4. **Tú:** Confirmas el nivel, solo si es Exigente o más. Con Ligero o Normal, Claude sigue solo.
5. **Claude:** Programa, prueba y se revisa a sí mismo. Delega el código al agente del nivel cuando hace falta.
6. **Tú:** Apruebas el encargo para Codex. Claude te lo muestra con preguntas, archivos y criterio de aprobación. Nada se envía sin tu OK.
7. **Codex:** Revisa en solo lectura y entrega un informe. Claude le avisa con `avisar` y Codex lo recibe en su misma sesión.
8. **Claude:** Verifica cada hallazgo y corrige lo que se sostenga. Máximo dos rondas por cambio.
9. **Tú:** Pides el commit y el PR. Tú decides el merge. Si el proyecto tiene memoria de Obsidian, `/cerrar-memoria` la pone al día.

Si Claude es el revisor, en su terminal escribe `/revisar`: espera en segundo plano sin gastar tokens y se activa cuando llega el encargo.

### Qué nivel se elige

| Total | Nivel | Claude | Codex |
| --- | --- | --- | --- |
| 0–2 | Ligero | `haiku · low` | `gpt-6-luna · low` |
| 3–4 | Normal | `sonnet · medium` | `gpt-6.1-sol · medium` |
| 5–6 | Exigente | `sonnet · high` | `gpt-6.1-sol · high` |
| 7–10 | Alto | `opus · high` | `gpt-6-astra · high` |

El total sale de cinco criterios: riesgo, tamaño, ambigüedad, contexto y tipo de trabajo. Riesgo alto (seguridad, datos, dinero, producción) fija un mínimo de Exigente. Se sube de nivel solo si la corrección falló. Los nombres de Codex salen de `modelos` y pueden cambiar.

## Comandos de terminal

### Instalación (`agent-toolkit`)

| Comando | Para qué |
| --- | --- |
| `node bin/agent-toolkit.js doctor --agent all` | Qué falta o qué está mal en la instalación. No cambia nada. |
| `node bin/agent-toolkit.js setup --agent all [--apply]` | Enlaza las skills. Sin `--apply` es vista previa; nunca reemplaza nada. |

### Revisiones, modelos y consumo (`agent-toolkit-inbox`)

| Comando | Para qué |
| --- | --- |
| `node bin/agent-toolkit-inbox.js modelos` | Qué modelos hay y la tabla de niveles vigente. |
| `node bin/agent-toolkit-inbox.js rendimiento` | Qué modelo y nivel rinden mejor (hallazgos que se sostienen). |
| `node bin/agent-toolkit-inbox.js consumo --project-root /ruta` | Tokens, caché y tiempo de las llamadas registradas. |
| `node bin/agent-toolkit-inbox.js agentes [--escribir [--forzar]]` | Crea los agentes de nivel de Codex. Sin `--escribir` es vista previa. |
| `node bin/agent-toolkit-inbox.js registrar --agent codex --project-root /ruta` | Guarda la sesión de Codex como revisora. Lo ejecuta `$revisar`; añade `--thread <id>` si no la encuentra. |
| `node bin/agent-toolkit-inbox.js avisar --project-root /ruta --task <id> --review <id>` | Avisa a Codex de un encargo ya aprobado. Lo ejecuta la skill, no tú. |
| `node bin/agent-toolkit-inbox.js cierre --project-root /ruta --task <id> --salida /ruta/traspaso.md` | Cierra una colaboración y deja un borrador de traspaso. Exige que no haya encargos activos. |

### Gemini (opcional, requiere agy) (`agent-toolkit-gemini`)

| Comando | Para qué |
| --- | --- |
| `node bin/agent-toolkit-gemini.js estado` | Versión de `agy` y modelos disponibles. |
| `node bin/agent-toolkit-gemini.js consultar --prompt "tu pregunta"` | Una explicación o respuesta directa. |
| `node bin/agent-toolkit-gemini.js investigar --prompt "tu pregunta"` | Búsqueda web con resumen y fuentes. |
| `node bin/agent-toolkit-gemini.js analizar --prompt "qué quieres saber" --archivo /ruta/informe.pdf` | Lee texto, imágenes, PDF o vídeo (sin audio). Hasta 8 archivos. |
| `node bin/agent-toolkit-gemini.js imagen --prompt "descripción"` | Genera una imagen. Sin vídeo ni audio. |
| `node bin/agent-toolkit-gemini.js historial` | Consultas anteriores. `recuperar --directorio <ruta>` trae un resultado sin volver a llamar al modelo. |

### Memoria de proyecto (opcional) (`project-memory`)

| Comando | Para qué |
| --- | --- |
| `node bin/project-memory.js init <carpeta-nueva> --source <repositorio-del-proyecto> --project-id mi-proyecto --project-name "Mi proyecto"` | Vista previa de una memoria nueva en Obsidian para ese proyecto. `--source` es obligatorio. Con `--apply` la crea. |
| `node bin/project-memory.js connect <bóveda> --agent claude` | Prepara la conexión de la memoria con Claude (o `--agent codex`). Con `--apply` la aplica. |
| `node bin/project-memory.js doctor <bóveda>` | Diagnóstico de la bóveda. |
| `node bin/project-memory.js sync plan <bóveda>` | Qué PR fusionados faltan por registrar en la memoria. |
| `node bin/project-memory.js sync inspect <bóveda> --pr 42` | Evidencia de un PR concreto, solo lectura. |
| `node bin/project-memory.js sync record <bóveda> --pr 42 --outcome documentation-updated --reviewed --summary "Producto actualizado" --note "01-PRODUCTO/Producto.md" --apply` | Registra un PR cuyas notas ya actualizaste: `--note` es obligatorio (repetible) con `documentation-updated`. Si no cambió nada, usa `--outcome no-documentation-change` sin resumen ni notas. Escribe solo con `--apply` y nunca hace commit ni push. |

`<bóveda>` es la carpeta de memoria de un proyecto, la que contiene `project-memory.json`. Solo `--apply` escribe, y nada hace commit ni push.

## Skills

| Skill | Para qué |
| --- | --- |
| `programar <tarea>` | Esta terminal programa y pide revisión a la otra. |
| `revisar` | Esta terminal es la revisora. |
| `estado` | Tabla de las revisiones abiertas, el encargo pendiente y el último veredicto. Solo lectura. |
| `gemini <lo que necesitas>` | Usa Gemini para explicar, investigar, analizar archivos o generar una imagen. `investigar` e `imagen` son atajos. Requiere `agy`. |
| `cerrar-memoria` | Tras fusionar un PR, pone al día la memoria de Obsidian del proyecto. Solo si el proyecto tiene `project-memory.json`. |
| `revision-cruzada` | Reúne todas las reglas de `programar` y `revisar`. Casi nunca la escribes tú. |
| `elegir-modelo` | Recomienda y comprueba el modelo y el esfuerzo de Claude Code, Codex y Antigravity con los nombres reales de tu equipo. Se activa sola al empezar una tarea o al preguntar qué modelo usar. |
| `spec-driven-development, depurar, desarrollo-con-pruebas, quality-gate` | Flujo de trabajo adaptado de Superpowers (especificar y planificar, investigar causa raíz antes de arreglar, TDD paso a paso y verificar con evidencia fresca). Convive con Superpowers si lo tienes instalado; ver [integración](../skills/superpowers-integration.md). |
| `differential-review, frontend-design, mcp-builder, web-design-guidelines, ordenar-proyecto` | Skills recomendadas que también instala `setup`: revisión de seguridad de un cambio, diseño de interfaces, crear servidores MCP, pautas web y ordenar archivos. |

La memoria de Obsidian no se actualiza sola: se hace con `/cerrar-memoria` después de fusionar un PR. `cerrar-avisens` es un alias del mismo cierre.

## Si algo falla

| Síntoma | Qué hacer |
| --- | --- |
| Cambié algo y no se nota | Reinicia Claude Code y Codex. |
| No sé qué falta | `node bin/agent-toolkit.js doctor --agent all` lo dice, con el comando para arreglarlo. |
| `node --version` no empieza por v24 | Instala Node.js 24 (por ejemplo con nvm o Homebrew) y repite `npm ci --ignore-scripts`. |
| `setup` indica un conflicto | Ya tienes una skill con ese nombre. No la reemplaza: revisa la ruta que muestra y decide cuál conservas. |
| Abro Codex con `--profile <nombre>` | Revisa con `doctor --agent codex --perfil-codex <nombre>`: así evalúa el permiso de ese perfil. |
| Moví o volví a clonar la carpeta | Repite `setup --apply` y el registro del servidor desde la nueva carpeta. |
| `$revisar` dice «No se pudo escribir en el registro de Agent Toolkit» | Es el sandbox de Codex. Haz el paso «Deja que Codex guarde su registro de revisor». |
| `avisar` dice que Codex no se registró | En Codex escribe `$revisar`. |
| `registrar` no encuentra la sesión | En Codex, `/status` da el id. Luego `registrar … --thread <id>`. |
| Codex tarda en reaccionar al aviso | Si está en mitad de un turno, el aviso espera a que termine. |
| Codex no reclama el encargo | Su modelo no coincide con el recomendado. Cámbialo con `/model`. |
| `agentes` dice «ya existe y es distinto» | Es lo esperado. Usa `--escribir --forzar` si quieres reemplazarlo; queda una copia. |
| `sync record` dice BLOCKED | Al repositorio le faltan CI o carpetas de área. Añade la fila a mano en el registro de la bóveda. |
| Gemini no responde o falta una imagen | `agent-toolkit-gemini estado` comprueba `agy`; una imagen tardía se trae con `historial` y `recuperar`. |

## Más información

| Qué | Dónde |
| --- | --- |
| Colaboraciones y revisiones | `~/.agent-toolkit/workflows/peers/` |
| Sesión de Codex registrada | `~/.agent-toolkit/workflows/reviewers/` |
| Resultados de Gemini | `~/.agent-toolkit/gemini/` |
| Skills | `~/.claude/skills/ (Claude) y ~/.agents/skills/ (Codex), como enlaces al repositorio` |
| Agentes de Codex | `~/.codex/agents/` |
| Memoria de un proyecto | La carpeta que elijas en `project-memory init` (la que contiene `project-memory.json`) |

Límites que conviene recordar:

- El esfuerzo de un agente lo fija su archivo, pero una variable como `CLAUDE_CODE_EFFORT_LEVEL` puede imponerse. El modelo sí se comprobó.
- El aviso directo a Codex se probó contra una sesión inactiva, no con un encargo real de principio a fin.
- Los agentes de solo lectura de Codex lo son por instrucción, no por sandbox.
- Gemini no participa en la revisión cruzada y no genera vídeo ni audio; el audio no se analiza.
- Probado en macOS con Node 24, clonando en carpetas distintas. No se ha comprobado en Linux ni en Windows.
- Todavía no hay una medición controlada que demuestre ahorro de tokens.
- Nada se fusiona, se sube ni se despliega sin tu autorización.

### Avanzado

Herramientas internas del servidor (solo para depurar):

| Grupo | Herramientas |
| --- | --- |
| Revisión cruzada | `start_collaboration, get_collaboration, publish_peer_context, preview_peer_review, approve_peer_review, request_peer_review, wait_for_peer_handoff, claim_peer_review, submit_peer_review, record_review_outcome, cancel_peer_review, close_collaboration` |
| Tareas por etapas | `start_task, get_task, preview_codex_plan, run_codex_plan, preview_claude_proposal, run_claude_proposal, preview_claude_implementation, run_claude_implementation, preview_codex_review, run_codex_review, wait_for_task_activity, cancel_task_execution` |

`approve_peer_review` es la que te pide permiso: no la pongas en la lista de permitidas ni en modo automático.

`agent-task` (borradores y verificación manual):

| Comando | Para qué |
| --- | --- |
| `node bin/agent-task.js prepare --task t.json --request r.json --catalog c.json --policy p.json` | Prepara un borrador. No usa IA ni consulta cuentas. Hay ejemplos en `examples/`. |
| `node bin/agent-task.js verify --contract c.json --expect <sha256> --source <raíz> --handoff <raíz> --phase before` | Compara las huellas de los archivos listados. |

Más detalle: [instalación, consumo y recuperación](consolidacion.md), [herramientas de Gemini](herramientas-gemini.md) y [primeros pasos](primeros-pasos.md).
