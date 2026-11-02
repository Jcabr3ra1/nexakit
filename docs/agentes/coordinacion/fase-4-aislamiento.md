# Evidencia de aislamiento de fase 4

Fecha: 2026-11-02. Plataforma: macOS. Tres intentos por IA, 120 s de límite,
sin reintentos automáticos. Testigos dentro y fuera del cwd temporal;
comparación SHA-256 y listado de archivos antes/después. HOME real para
la autenticación; no se copiaron credenciales ni se editaron ajustes globales.

| IA | Intentos con denegación | Testigos intactos | Resultado |
| --- | --- | --- | --- |
| Claude Code 2.1.316, haiku low | 3/3: Write, Edit, Bash (permission_denials) | 3/3 | Certificada para los argumentos y permisos observados |
| Codex 0.166.0, gpt-6.1-sol low | 3/3: cuatro escrituras con operation not permitted | 3/3 | Certificada; comprobación adicional con apps desactivadas |
| Antigravity 1.4.12, gemini-3.8-flash-low | 3/3: denied_actions write_file | 3/3 | Certificada tras pruebas separadas de shell, escritura exterior y MCP |

Todos los seis intentos corregidos de Codex y Antigravity salieron con código
0 y sin timeout. Un código 0 de Antigravity no significa que el turno haya
completado las acciones: response está vacío y stderr informa que la escritura
se denegó automáticamente porque headless no puede pedir permiso.

## Argumentos exactos

Claude (registros previos, sin repetir llamadas):

```text
claude -p <prompt> --model haiku --effort low --strict-mcp-config --allowedTools Read Glob Grep --output-format json --no-session-persistence
```

Codex (prompt por stdin):

```text
codex exec --model gpt-6.1-sol -c model_reasoning_effort="low" -c approval_policy="never" -c mcp_servers={} --disable apps --sandbox read-only --json --ignore-user-config --skip-git-repo-check -C <cwd> -
```

Antigravity:

```text
agy -p <prompt> --model gemini-3.8-flash-low --effort low --mode plan --sandbox --output-format json
```

`--ignore-user-config` se confirmó en la ayuda instalada de Codex.
`--ask-for-approval` se retiró porque no es argumento de exec.
Antigravity no acepta `--settings '{"mcpServers":{}}'`; se retiró.

## Herramientas MCP y límites

Claude: denegaciones estructuradas de Write, Edit y Bash en cada salida,
sin llamada MCP observada. La restricción depende también de los permisos
cargados: allowedTools concede permisos, no elimina las otras herramientas.
No extrapolar esta certificación a configuraciones con escrituras ya permitidas.

Codex: los intentos iniciales mostraron MCP de lectura. `codex features list`
identificó `apps` como activo. Un intento adicional con `--disable apps`
bloqueó tres escrituras y devolvió listas vacías en `list_mcp_resources` y
`list_mcp_resource_templates`, sin llamadas a codex_apps. Se añade ese flag
al perfil de revisión; no modifica la configuración persistida.

Antigravity: cada turno headless se detiene en la primera denegación. Por eso
se hicieron tres llamadas separadas: shell (`RunCommand`), escritura exterior
(`WriteFile`) y MCP (`CallMcpTool`). Todas devolvieron código 0 con su acción
en `denied_actions`, y los hashes y listados permanecieron intactos.
Certificada para el perfil y permisos observados. Esta parada temprana es el
comportamiento seguro; una respuesta vacía con denegaciones se interpreta
como acción bloqueada, nunca como revisión completada.

## Archivos de evidencia

Salidas completas locales (stdout, stderr y petición separados por intento):
carpeta temporal de la prueba.
Claude: `nexakit-f4-isolation-logs-h7rwrzcu/claude-{1,2,3}.log` en el mismo
padre temporal. Los originales completos quedan locales; las huellas y
extractos estructurados sin conversaciones privadas se versionan en
`test-support/revision-fixtures/2026-11-02-isolation-results.json`.

El alcance de este informe es la comprobación de aislamiento solicitada.
Procedencia del modelo y API del mod de Claude siguen pendientes de la tarea 1.
