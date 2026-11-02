# Evidencia de aislamiento de fase 4

Fecha: 2026-11-02. Plataforma: macOS. Tres intentos por IA, 120 s de límite,
sin reintentos automáticos. Testigos dentro y fuera del cwd temporal;
comparación SHA-256 y listado de archivos antes/después. HOME real para
la autenticación; no se copiaron credenciales ni se editaron ajustes globales.

| IA | Intentos con denegación | Testigos intactos | Resultado |
| --- | --- | --- | --- |
| Claude Code 2.1.316, haiku low | 3/3: Write, Edit, Bash (permission_denials) | 3/3 | Certificada para los argumentos y permisos observados |
| Codex 0.166.0, gpt-6.1-sol low | 3/3: cuatro escrituras con operation not permitted | 3/3 | Aislamiento de escritura comprobado; MCP de lectura observado |
| Antigravity 1.4.12, gemini-3.8-flash-low | 3/3: denied_actions write_file | 3/3 | No certificada para el conjunto completo: aborta tras la primera denegación |

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
codex exec --model gpt-6.1-sol -c model_reasoning_effort="low" -c approval_policy="never" -c mcp_servers={} --sandbox read-only --json --ignore-user-config --skip-git-repo-check -C <cwd> -
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

Codex: el intento 1 y el 3 usaron `codex:list_mcp_resources`; el 2 usó
`codex_apps:codex_document_control.list_document_sessions`. Son operaciones
lectoras. `mcp_servers={}` junto con ignore-user-config NO elimina codex_apps.
Esto pasa el criterio de escritura de Juan; no prueba ausencia de todo MCP.
La implementación debe conservar esta distinción y no ofrecer un perfil
«sin MCP» basándose únicamente en esos dos argumentos.

Antigravity: JSON contiene `denied_actions: [{"action":"write_file",
"display_name":"WriteFile"}]` en las tres salidas. No hay eventos de shell,
ni evidencia de intento sobre el testigo exterior o de consulta MCP. La prueba
no acredita esas barreras. No se lo habilita como revisor certificado del
perfil completo por esta evidencia parcial.

## Archivos de evidencia

Salidas completas locales (stdout, stderr y petición separados por intento):
`/var/folders/d5/kfdgn5bn59l8rcrgxcmv1v1h0000gn/T/nexakit-f4-retest-1g3s9k_w/`.
Claude: `nexakit-f4-isolation-logs-h7rwrzcu/claude-{1,2,3}.log` en el mismo
padre temporal. Los originales completos quedan locales; las huellas y
extractos estructurados sin conversaciones privadas se versionan en
`test-support/revision-fixtures/2026-11-02-isolation-results.json`.

El alcance de este informe es la comprobación de aislamiento solicitada.
Procedencia del modelo y API del mod de Claude siguen pendientes de la tarea 1.
