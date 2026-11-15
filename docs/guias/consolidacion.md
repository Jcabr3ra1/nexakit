# Consolidación: instalación, consumo y recuperación

## Instalación común

Desde la raíz de un checkout estable, con Node 24 y dependencias instaladas:

```sh
node bin/agent-toolkit.js doctor --agent all
node bin/agent-toolkit.js setup --agent all
node bin/agent-toolkit.js setup --agent all --apply
```

`setup` enlaza las skills de este checkout. La vista previa no escribe; apply
preserva cualquier destino diferente y no reemplaza una instalación previa.
Si hay conflicto, revisa sus rutas antes de decidir qué instalación conservar.
El comando devuelve las recetas MCP para Codex/Claude: ejecútalas únicamente si
falta el servidor y reinicia el cliente. El registro MCP y los agentes por nivel
siguen siendo pasos explícitos; no se modifica silenciosamente configuración.
No instales desde un worktree temporal que vayas a borrar.

`doctor` informa Node, dependencias, presencia de CLIs, skills y configuración MCP.
Con Codex informa además `codexSandbox`: si su sandbox deja escribir en
`~/.agent-toolkit`, donde la herramienta Gemini guarda su historial y su consumo. Si
falta, imprime el comando que añade `[sandbox_workspace_write] writable_roots`
sin duplicar la sección; sin ese permiso esa escritura falla con un error de
escritura (EPERM). Si `sandbox_mode` está presente, manda sobre
`default_permissions`; `:read-only` bloquea la escritura. Si abres Codex con
`--profile <nombre>`, añade `--perfil-codex <nombre>` a `doctor` o `setup` para
evaluar `<nombre>.config.toml` sobre `config.toml`; sin él, el resultado lista
los perfiles que encuentra y avisa de que no los evaluó.
Que algo esté configurado no demuestra que una sesión nueva lo haya cargado.
Superpowers es obligatorio: `npx nexakit` lo instala o activa con el gestor de
plugins de cada IA, y `doctor` informa su estado por IA. Para agentes por nivel, usa
`nexakit codex agentes`. La revisión por otra IA es opcional: solo con `/fabrica`
o si la pides.

## Medir sin inventar ahorro

`nexakit codex consumo` resume el consumo local de Codex y `nexakit ahorro` lo que
recorta el mod `nexakit-ahorro`. Gemini registra automáticamente los contadores
declarados de cada consulta explícita en `~/.agent-toolkit/gemini/consumo.jsonl`;
`agent-toolkit-gemini historial` lista las consultas guardadas.

El origen de un contador es declarado, no autenticado. No sumes caché nuevamente
a entrada/total ni atribuyas un precio al consumo de una suscripción. El reporte
no captura llamadas que nadie registró ni acredita ahorro.

Para evaluar ahorro, compara tareas equivalentes con y sin Toolkit, con la misma
calidad exigida. Conserva tokens de entrada/caché/salida, tiempo, llamadas, rondas
y hallazgos válidos. No hay todavía una comparación controlada en vivo, con y sin
NexaKit sobre las mismas tareas, que pruebe el ahorro total.

### Medición sin conexión de `nexakit-ahorro` (2026-11-11)

Se aplicó el recorte del mod a las salidas de Bash guardadas en las
transcripciones de Claude Code de un solo equipo, del 2026-09-12 al 2026-11-12:
las mismas salidas con y sin recorte, sin gastar cuota.

| Dato | Valor |
| --- | --- |
| Salidas de Bash analizadas | 10.765, en 33 transcripciones |
| Salidas que el mod habría recortado | 544 (5,1 %) |
| Caracteres en esas salidas, antes y después | 4.710.147 y 1.650.018 |
| Ahorro en las salidas recortadas | 65,0 % |
| Ahorro sobre toda la salida de Bash | 21,8 % |
| Ahorro en caracteres | 3.060.129 (unos 765.000 tokens, caracteres / 4) |
| Ahorro mediano por recorte | 4.304 caracteres |

Límites: los tokens son una estimación, no un conteo; son datos de una persona y
siete proyectos, y uno aporta el 36 % del ahorro; quedaron fuera 26 salidas que ya
llevaban la marca del mod. No mide las relecturas de cada salida en los turnos
siguientes (el ahorro real es mayor), ni si el recorte obligó a repetir un comando
para ver la salida entera, ni el efecto de delegar por niveles o de la caché.

## Evidencia y progreso

- Base: 4.608 pruebas pasaron antes de los cambios en Node 24.14.1/macOS.
- Verificación final: `npm test`, 4.632 pruebas aprobadas, cero fallos, omitidas o
  canceladas (49,8 s). Tras un ajuste de sangría, Gemini volvió a pasar 17/17.
  `git diff --check` y las ayudas CLI también pasaron.
- Task 1: métricas, persistencia, deduplicación, cobertura, CLI y MCP comprobados.
- Task 2: preview sin escrituras, instalación idempotente, conflictos y diagnóstico
  comprobados con hogares ficticios. Diagnóstico local ejecutado sin cambiarlo.
- Task 3: consultas, análisis, historial y recuperación con Antigravity. Entradas
  multimedia contrastadas en la guía Gemini. Audio bloqueado por fallos nativos.
- Task 4: `test/toolkit-journey.test.js` une fuente y memoria ficticias, encargo,
  aviso, reclamación, informe, consumo, cierre y recuperación en otra instancia.
  El aviso y los participantes de esa prueba son simulados, no sesiones IA reales.
- Revisión independiente: identificó tres defectos que se corrigieron con pruebas
  que fallaban antes de la corrección: cierre concurrente, consumo perdido ante
  fallos posteriores a la inferencia y recuperación que omitía el estado parcial.
  El cierre ahora conserva el bloqueo mientras escribe el borrador; las otras dos
  correcciones preservan consumo y estado del análisis, respectivamente.
- Gemini nativo: generación de imagen inspeccionada visualmente y recuperación
  de la misma conversación sin inferencia adicional. Las pruebas de audio fallidas
  se conservan como evidencia de una limitación, no como soporte de esa modalidad.
- Instalación activa: `doctor` detecta MCP apuntando a otro checkout y skills ya
  existentes. Es el resultado esperado desde este worktree; no se reemplazaron.

Rulings: se usa solo suscripción Antigravity por elección expresa del usuario;
no se añade API. Se conserva audio bloqueado por evidencia negativa. Se añade
borrador explícito de cierre para unir recuperación y memoria sin actualizar notas
vigentes. La entrega inicial no se publicó ni instaló en los clientes activos;
la activación posterior del cierre global se detalla al final.

## Cierre global de memoria — 28 de octubre de 2026

`cerrar-memoria` se generalizó para cualquier manifiesto, sin tabla de proyectos,
ramas ni carpeta de Obsidian fijas. Identifica candidatos por el contexto, skill de
memoria y raíces MCP conocidas; verifica repositorio/worktree y pide una ruta si
falta una asociación inequívoca. El nombre, rama de integración, rama de revisión
y rama de la bóveda se leen del manifiesto.

`/cerrar-memoria` y `$cerrar-memoria` autorizan el mismo cierre documental. Se
conservan reglas de autoría del proyecto, evidencia de integración y permisos
separados para código, commits, publicación y sincronización. Un registro bloqueado
permanece pendiente; se retiró el antiguo fallback de marcarlo manualmente como
revisado. También hay un flujo para eventos estables sin PR ni automatización.

La plantilla de memoria nueva y la revisión por otra IA (opcional, con `/fabrica`) remiten al cierre global.
`cerrar-avisens` conserva compatibilidad como alias del mismo flujo. Esta mejora
no actualiza notas de las bóvedas reales ni modifica sus reglas de proyecto.

Verificación del cierre global: revisión independiente de siete escenarios,
validación del formato de ambas skills y 15/15 pruebas de inicialización e
instalación. Se comprobó que las plantillas nuevas generan skills válidas y
que instalar sigue siendo idempotente y conserva conflictos.

Activación local solicitada: se verificaron cuatro enlaces globales,
`cerrar-memoria` y su alias en `~/.agents/skills` y `~/.claude/skills`. Los dos
enlaces antiguos del alias se conservaron en una copia de instalación bajo
`~/.agent-toolkit/backups/skills/`. Apuntan a este checkout y deben actualizarse
al integrar o trasladar el worktree. Las sesiones nuevas cargan las skills; esto
no cambia la configuración MCP ni acredita un cierre real de las bóvedas.
