# Project Memory Connect

`project-memory connect` prepara la conexión local de una memoria con un agente
compatible. La vista previa es el comportamiento predeterminado; solo `--apply`
autoriza cambios en la configuración personal del agente.

## Uso

```bash
project-memory connect /ruta/a/la/memoria --agent codex
project-memory connect /ruta/a/la/memoria --agent claude --apply
```

También se puede pasar directamente la ruta de `project-memory.json`.

## Contrato

1. Lee y valida el manifiesto v1.
2. Comprueba que el agente exista y esté habilitado.
3. Localiza la Skill declarada en
   `07-AGENTES/skills/<skillName>/SKILL.md`.
4. Prepara un enlace simbólico hacia la ubicación personal del agente.
5. Registra un MCP `stdio` limitado a la bóveda.
6. Aplica una lista blanca de herramientas de lectura o una lista de bloqueo
   equivalente para impedir escrituras desde el MCP.

Las conexiones nuevas fijan la versión verificada de
`@modelcontextprotocol/server-filesystem` (`2.3.0`) y lo arrancan con dos opciones:

- `--read-only`: el propio servidor no ofrece ninguna herramienta que escriba,
  permita lo que permita el cliente.
- `--confine-roots`: las carpetas (Roots) que anuncia el cliente no sustituyen a
  la bóveda. Sin esta opción, un cliente que envía su proyecto como Root hace que
  el servidor sirva el proyecto y deje de leer la bóveda.

Las políticas por cliente se mantienen como segunda barrera, para que una
actualización futura no exponga herramientas no enumeradas.

Una conexión hecha con una versión anterior de nexakit (otra versión del
servidor, o sin esas opciones) sigue funcionando. `connect` la muestra como
`update` y, con `--apply`, la sustituye por la nueva; `npx nexakit` la propone
como paso pendiente. No es un conflicto.

Herramientas permitidas:

- `read_text_file`
- `read_media_file`
- `read_multiple_files`
- `list_directory`
- `list_directory_with_sizes`
- `directory_tree`
- `search_files`
- `get_file_info`
- `list_allowed_directories`

Herramientas bloqueadas explícitamente cuando la plataforma usa una lista de
denegación:

- `create_directory`
- `write_file`
- `edit_file`
- `move_file`
- `append_file`
- `copy_file`

## Adaptadores

| Agente | Skill personal | Registro MCP | Política de lectura |
| --- | --- | --- | --- |
| Codex | `~/.agents/skills/` | `codex mcp` | `enabled_tools` en `~/.codex/config.toml` |
| Claude Code | `~/.claude/skills/` | `claude mcp --scope user` | reglas `allow` y `deny` de usuario |

## Seguridad e idempotencia

- Sin `--apply` no se escriben archivos ni se ejecutan comandos de registro.
- Un archivo, directorio o enlace diferente en el destino de la Skill es un
  conflicto y no se reemplaza.
- Un MCP existente con comando, argumentos o bóveda diferentes es un conflicto.
- La aplicación se cancela antes de escribir si cualquier parte del plan entra
  en conflicto.
- Repetir una conexión correcta produce estado `unchanged`.
- No se copian secretos, variables de entorno ni credenciales.
- La herramienta no modifica el repositorio fuente ni la bóveda.

Después de aplicar, se debe reiniciar la sesión del agente y ejecutar una
consulta pequeña que obligue a leer una nota conocida.
