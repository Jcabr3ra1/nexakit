# Equipo de agentes en Codex

El principal entiende la tarea, decide, divide el trabajo y verifica las
entregas. Los subagentes ejecutan encargos acotados con modelo y esfuerzo
propios. Las tareas de uno o dos pasos se pueden resolver directamente para
evitar el coste de abrir otro agente.

## Preparar el equipo

```sh
nexakit codex agentes
nexakit codex agentes --json
nexakit codex agentes --apply
nexakit codex agentes --apply --actualizar
```

Por defecto solo muestra lo que haría. `--apply` crea perfiles faltantes.
`--actualizar` requiere `--apply` y permite actualizar perfiles distintos,
conservando los anteriores con un sufijo `.anterior-*`. Primero revisa la
vista previa. Si un archivo cambia después de planificar, no se sustituye
silenciosamente. No se eliminan otros agentes.

Los perfiles se crean en `$CODEX_HOME/agents/`, o en `~/.codex/agents/` si no
definiste `CODEX_HOME`. Modelo y esfuerzo se resuelven con el catálogo local de
Codex: si falta uno soportado, el informe lo dice y no inventa un perfil.
Esta operación no cambia el modelo principal, su esfuerzo, la barra ni tus
permisos. No escribe instrucciones nuevas en tu `AGENTS.md` personal.

## Los diez perfiles

| Agente | Para qué | Configuración |
| --- | --- | --- |
| `nivel_ligero` | Comandos, búsquedas y cambios mecánicos | Nivel ligero del catálogo |
| `nivel_normal` | Implementar con un diseño claro | Nivel normal |
| `nivel_exigente` | Pruebas, casos borde y fallos acotados | Nivel exigente |
| `nivel_alto` | Fallos sutiles, seguridad o lo que exigente no resolvió | Nivel alto |
| `investigador` | Documentación y fuentes oficiales | Normal |
| `revisor_de_calidad` | Dictamen de calidad con evidencia | Exigente |
| `cierre_de_memoria` | Notas y registro de entregas autorizados | Normal |
| `subir_al_repo` | Commit, push, PR, espera del CI y fusión autorizados | Normal |
| `sincronizador_docs` | Detectar contradicciones entre documentación y código | Normal |
| `cazador_de_flakes` | Determinar si un fallo del CI es intermitente | Normal |

Los presupuestos de pasos y la instrucción de solo lectura delimitan el
encargo. No equivalen a un sandbox individual: Codex hereda la política efectiva
del padre y su formato de perfiles no reproduce todos los controles de Claude.
No se añaden campos `maxTurns`, `tools` o `sandbox_mode` como si impusieran
restricciones que el cliente no soporta.

## Selección y trabajo diario

El hook `UserPromptSubmit` conserva la recomendación visible y puede aportar
orientación al agente principal mediante `additionalContext`. Usa únicamente
perfiles instalados válidos. Eso permite distinguir un aviso para ti de una
pauta que también recibe el modelo.

El hook no lanza clientes de IA ni ejecuta la delegación: el principal utiliza
las herramientas nativas de Codex cuando la tarea lo justifica. Si el perfil
todavía no aparece entre sus agentes disponibles, debe usar uno registrado o
resolver el trabajo directamente, sin inventar un tipo de agente.

Después de instalar o actualizar perfiles, abre una sesión nueva para cargar
sus descripciones. Usa `/subagents` para consultar los hilos y sus resultados.
Una configuración escrita en disco no prueba que una conversación ya abierta
haya cargado los cambios.

Cada encargo debe incluir objetivo, archivos, criterio de finalización y las
autorizaciones aplicables. Las búsquedas independientes se pueden paralelizar;
las escrituras sobre los mismos archivos se coordinan. El principal debe
comprobar el informe y reutilizar pruebas frescas del mismo árbol, sin repetir
por defecto la suite completa en cada subagente.

## Autorizaciones que se conservan

- `subir_al_repo` necesita que el encargo indique el pedido escrito de la
  persona, los archivos y la evidencia de verificación. Esperar CI pendiente es
  parte del trabajo; solo se fusiona el SHA comprobado con los checks en verde.
- `cierre_de_memoria` requiere que la persona haya pedido actualizar la memoria.
  No implica permiso para hacer commit o push de la bóveda.
- `revisor_de_calidad` es un rol interno de Codex. No autoriza lanzar Claude,
  Gemini ni una revisión cruzada: eso sigue requiriendo la petición explícita.
- Una frase citada, una pregunta sobre un comando o una negación no constituyen
  autorización de ejecución.

## Alcance de esta integración

El equipo y la orientación de selección son una parte del flujo de NexaKit en
Claude. La [medición y barra de Codex](codex-ahorro.md) se mantienen aparte.
El recorte de salidas dispone del wrapper `codex ejecutar` y del hook opcional
`PostToolUse` descrito en la guía de ahorro; no intercepta todos los comandos. Los mods de
lecciones y guardarraíles requieren sus adaptadores de eventos propios.

Fuentes oficiales: [subagentes](https://learn.chatgpt.com/docs/agent-configuration/subagents)
y [hooks](https://learn.chatgpt.com/docs/hooks), consultadas el 12 de noviembre
de 2026. La garantía de una instalación se informa separada de las pruebas con
fixtures y de una delegación real.
