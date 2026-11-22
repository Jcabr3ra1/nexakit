# Guía de uso de NexaKit

Esta guía reúne la información técnica que antes estaba en el README principal.
Para conocer el propósito sin entrar en comandos, vuelve a la
[presentación del proyecto](../../README.md).

Si es tu primera prueba, empieza por [Primeros pasos](primeros-pasos.md): usa
ayudas y datos ficticios, sin instalar clientes ni ejecutar IA. El
[hito R1](../operacion/agent-toolkit-private-beta.md) separa esa base local de la validación
integrada, una instalación limpia y la publicación privada pendiente.

Los ejemplos que empiezan con `project-memory` presuponen que el comando está
instalado en tu equipo. Desde el repositorio también puedes ejecutarlos usando
`node bin/project-memory.js` seguido de la operación. `npm install` instala las
dependencias, pero por sí solo no instala el comando globalmente.

### Runtime de la base local actual

La base local RG3-A1b, autorizada el 2026-10-13, declara Node **24.x**
(`^24.0.0`) en package.json y en la raíz del lock. Sustituye el rango anterior
`>=20`: versiones 20, 22 y majors posteriores a 24 quedan fuera de este rango
declarado. No significa que se hayan probado y encontrado defectuosas.
La evidencia inicial es Node 24.14.1 en macOS/arm64, no toda la rama 24.x.

Antes de actualizar una instalación, comprueba su versión de Node y el lock
revisado; instala con `npm ci --ignore-scripts` usando configuración npm sin
credenciales innecesarias. No hay un paso autorizado de actualización del equipo,
instalación global o publicación. Este cambio local no altera la beta histórica.

## Estructura

La base aislada del [intermediario MCP de raíz fija](../memoria/project-memory-mcp-guard.md)
se ejecuta con `node bin/project-memory-mcp.js --manifest <manifiesto-absoluto>`.
Es un servidor STDIO para un host MCP, no un chat interactivo: no configura
clientes, no ejecuta modelos y no modifica la bóveda. Su catálogo contiene nueve
lecturas y las raíces del host no cambian el destino fijado por el manifiesto.
Las dependencias deben estar instaladas previamente con el lock; no usa npx ni
descarga paquetes al arrancar. Su adopción en clientes reales queda en RG-2;
connect/status todavía usan sus adaptadores anteriores.


- `skills/`: procedimientos reutilizables compatibles con el formato `SKILL.md`.
- `agents/codex/`: agentes personales de Codex en formato TOML.
- `agents/claude/`: subagentes personales de Claude Code en Markdown con frontmatter YAML.
- `docs/`: arquitectura, decisiones y guías del sistema reutilizable.
- `schemas/`: contratos verificables para manifiestos y configuraciones.
- `bin/`: puntos de entrada locales de `nexakit`, `project-memory` y el servidor MCP de la fábrica.
- `src/`: diagnósticos y operaciones seguras de la CLI.
- `test/`: pruebas automáticas con el ejecutor nativo de Node.js.

La arquitectura inicial del sistema de memoria está en [`docs/memoria/project-memory-system.md`](../memoria/project-memory-system.md). Su manifiesto se valida con [`schemas/project-memory.schema.json`](../../schemas/project-memory.schema.json).

## Skills disponibles

- `mcp-builder`: diseño y revisión de servidores MCP; conserva recursos de evaluación opcionales con requisitos propios.
- `differential-review`: revisión de seguridad de cambios concretos, con historia Git y evidencia; alcance y licencia en [Fuentes de las skills](../skills/fuentes-de-skills.md).
- `web-design-guidelines`: revisión de interfaces con las Web Interface Guidelines de Vercel Labs, fijadas en la skill con su licencia MIT.
- `frontend-design`: guía de diseño frontend de Claude Code Templates, con fuente y licencia registradas en [Fuentes de las skills](../skills/fuentes-de-skills.md).
- `ordenar-proyecto`: organiza archivos y carpetas y ayuda a ubicar archivos nuevos conservando sus referencias.
- `decision-records`: documenta decisiones confirmadas con contexto y consecuencias.
- `project-handoff`: prepara traspasos breves y verificables entre sesiones o agentes.
- `quality-gate`: puerta antes de un PR o de pedir una revisión por otra IA; revisa requisitos, riesgos y diff sobre la evidencia fresca de Superpowers.

El proceso de trabajo (diseñar, planificar, depurar, TDD y verificar) lo pone [Superpowers](../skills/superpowers-integration.md), obligatorio: `npx nexakit` lo instala en cada IA.
- `elegir-modelo`: recomienda y comprueba el modelo y el esfuerzo de Claude Code, Codex y Antigravity con el criterio de Anthropic: el esfuerzo es el por defecto de cada modelo salvo para iterar, verificar o trabajo crítico desatendido, y el modelo sube cuando hace falta saber más.

Las equivalencias de proceso y reglas de convivencia con el plugin opcional Superpowers están en [Integración y adaptación de Superpowers](../skills/superpowers-integration.md).

## Pedir una revisión a otras IA

La revisión por otras IA la lanza el agente por su cuenta al cerrar una tarea con
código y antes de un PR; también puedes pedirla. Con la skill `fabrica` (o
`nexakit fabrica`) se propone un recorrido por estaciones y se lanza con la huella de
la propuesta; las IA externas leen el diff sin escribir. Detalles y
límites en [la fábrica de revisión](../agentes/coordinacion/fabrica.md).

## Perfiles disponibles

- `project_explorer`: explora repositorios en modo de solo lectura.
- `requirements_analyst`: convierte necesidades en requisitos comprobables.
- `solution_architect`: compara alternativas técnicas y sus consecuencias.
- `quality_reviewer`: detecta defectos, riesgos y pruebas faltantes.
- `docs_researcher`: consulta documentación oficial y versionada.
- `implementation_tutor`: guía implementaciones paso a paso sin sustituir al usuario.

Los perfiles de solo lectura lo son **por instrucción**, no por sandbox. Un
agente personal de Codex no puede fijar su propio `sandbox_mode`: hereda el
sandbox y las aprobaciones de la sesión que lo lanza, y el campo se ignora en el
archivo, así que no se incluye. Para una garantía real, ejecuta la sesión
principal con un sandbox de solo lectura. Con la sesión en `workspace-write`, un
agente que ignore su instrucción podría editar.

## Instalación local

Este repositorio es la fuente canónica. Sus componentes se instalan mediante enlaces simbólicos:

- Skills para Codex: `~/.agents/skills/`.
- Skills para Claude Code: `~/.claude/skills/`.
- Agentes para Codex: `~/.codex/agents/`.
- Agentes para Claude Code: `~/.claude/agents/`.

Los enlaces evitan copias divergentes: una actualización en esta biblioteca queda disponible para las plataformas conectadas después de reiniciar la sesión cuando sea necesario.

## Memorias de proyecto

Cada proyecto conserva por separado:

- su repositorio como fuente principal de verdad;
- una bóveda privada para contexto estable;
- un MCP de solo lectura;
- una Skill específica que aplica búsqueda progresiva;
- reglas de escritura y sincronización controladas.

`Agent-Toolkit` contiene únicamente componentes reutilizables. No almacena el conocimiento privado de los proyectos.

## Diagnóstico de una memoria

La primera herramienta ejecutable es `project-memory doctor`. Inspecciona una memoria sin modificarla.

```bash
npm install
node bin/project-memory.js doctor /ruta/a/la/memoria
```

Opciones principales:

- `--manifest <ruta>`: utiliza un manifiesto concreto.
- `--json`: devuelve un informe estructurado.
- `--strict`: trata las advertencias como error.

La guía completa está en [`docs/memoria/project-memory-doctor.md`](../memoria/project-memory-doctor.md).

## Crear una memoria

`project-memory init` genera una vista previa segura de una memoria canónica:

```bash
project-memory init /ruta/al/proyecto-memory \
  --project-id mi-proyecto \
  --project-name "Mi Proyecto" \
  --source /ruta/al/repositorio
```

La creación solo ocurre al repetir el comando con `--apply`. No sobrescribe archivos distintos ni configura Git, MCP o agentes por su cuenta. Consulta [`docs/memoria/project-memory-init.md`](../memoria/project-memory-init.md) para ver el contrato completo.

## Conectar un agente

`project-memory connect` inspecciona y prepara la Skill, el MCP y la política de
solo lectura de una plataforma concreta:

```bash
project-memory connect /ruta/a/proyecto-memory --agent codex
project-memory connect /ruta/a/proyecto-memory --agent claude
```

La vista previa no modifica el equipo. Después de revisarla, `--apply` crea
únicamente los elementos ausentes y se detiene ante enlaces o servidores
homónimos diferentes. La guía completa está en
[`docs/memoria/project-memory-connect.md`](../memoria/project-memory-connect.md).

## Consultar el estado

`project-memory status` reúne el diagnóstico de la bóveda y la comprobación de
todas las conexiones habilitadas:

```bash
project-memory status /ruta/a/proyecto-memory
```

La orden es de solo lectura. Admite `--agent`, `--json` y `--strict`, y distingue
entre un sistema saludable, una conexión pendiente y un conflicto. Consulta
[`docs/memoria/project-memory-status.md`](../memoria/project-memory-status.md) para ver el
contrato completo.

## Planificar una sincronización

`project-memory sync plan` detecta los Pull Requests de GitHub que fueron
fusionados en la rama configurada y todavía no aparecen como revisados en el
registro Markdown de la memoria:

```bash
project-memory sync plan /ruta/a/proyecto-memory
```

La orden es de solo lectura: no modifica notas, no registra PR y no crea commits.
Admite `--limit`, `--json` y `--strict`. Consulta
[`docs/memoria/project-memory-sync.md`](../memoria/project-memory-sync.md) para ver el contrato
completo.

## Inspeccionar un cambio fusionado

`sync inspect` reúne evidencia de un PR explícito y sugiere áreas de la memoria
que conviene revisar. Usa el repositorio y la rama declarados en el manifiesto:

```bash
project-memory sync inspect /ruta/a/proyecto-memory --pr 42
project-memory sync inspect /ruta/a/proyecto-memory --pr 42 --json --strict
```

El número `42` es un ejemplo: sustitúyelo por el PR que quieras inspeccionar.

El código de primer nivel (`src/`, `lib/`, `bin/`, `plugins/`, `schemas/`…) y la configuración de la raíz (`package.json`, `.gitignore`, `.claude-plugin/`) se clasifican solos. Si una categoría tiene varias carpetas candidatas en la bóveda, el manifiesto puede elegir una con `automation.areas` (requiere nexakit 0.7.0 o superior); se explica en [Project Memory Sync Inspect](../memoria/project-memory-sync-inspect.md).
Requiere GitHub CLI (`gh`) disponible y autenticado para ese repositorio.
No descarga código ni diffs, no ejecuta pruebas y no modifica notas ni el registro.
Los estados `ready`, `partial` y `blocked` describen la evidencia disponible;
`ready` no aprueba el código ni autoriza actualizar Obsidian. Con `--strict`,
`partial` y `blocked` devuelven código 1. Admite `--max-files` (200 por defecto).
Consulta el [contrato y la evidencia local](../memoria/project-memory-sync-inspect.md).

## Registrar una revisión terminada

`sync record` deja constancia de una conclusión ya revisada. Su vista previa
consulta GitHub, verifica el PR fusionado y comprueba el registro y los cambios
locales, sin escribir archivos:

```bash
project-memory sync record /ruta/a/proyecto-memory \
  --pr 42 --outcome no-documentation-change --reviewed
```

Si el resultado es correcto y autorizas guardar la fila, repite la orden con
`--apply`. Si actualizaste notas, declara un resumen y sus rutas exactas:

```bash
project-memory sync record /ruta/a/proyecto-memory \
  --pr 42 --outcome documentation-updated --reviewed \
  --summary "Actualizar el contrato de integración" \
  --note "03-IMPLEMENTACION/Contrato de integración.md"
```

El PR, la ruta y la nota son ejemplos; usa las rutas permitidas de tu memoria.
Las notas deben estar editadas y revisadas antes: el comando no las redacta.
`--reviewed` declara una revisión semántica terminada; no certifica el código.
Admite `--manifest` y `--json`. No admite `--force`, `--commit` ni `--push`.

Para registrar una revisión nueva exige comprobaciones completas y satisfactorias;
se detiene ante archivos ajenos, conflictos, enlaces inseguros o patrones de
secretos. Repetir el mismo resultado conserva la fila y su fecha.
**No edites ni sincronices la memoria durante `--apply`**: su bloqueo coordina
esta herramienta, no Obsidian ni otros editores.

La nueva base está implementada, probada y aprobada para su commit local;
su publicación está pendiente. Consulta [el contrato y sus límites](../memoria/project-memory-sync-record.md)
antes de aplicarla sobre una memoria real. No añade archivos a Git ni hace push.

## Aplicar una propuesta revisada de notas

`sync apply` no redacta notas: valida un JSON con su contenido completo, las
rutas existentes, los archivos fuente del PR y las huellas de sus versiones.
Guarda ese JSON fuera de la bóveda y prepara primero una vista previa:

```bash
project-memory sync apply /ruta/a/proyecto-memory \
  --proposal /ruta/a/propuestas/cambio-42.json --json
```

Revisa las diferencias y el significado contra el repositorio. Solo después
de autorizar ese plan concreto repite la orden con su `planId`:

```bash
project-memory sync apply /ruta/a/proyecto-memory \
  --proposal /ruta/a/propuestas/cambio-42.json \
  --apply --reviewed --expect "HUELLA_SHA256_DEL_PLAN_REVISADO"
```

Las rutas y la huella son ilustrativas. Exige Git limpio, salvo notas declaradas
que ya coincidan con la propuesta, PR fusionado y CI completo satisfactorio.
**Pausa Obsidian y la sincronización mientras aplicas.** El bloqueo se comparte
con `sync record`, pero no controla otros editores.

Un fallo entre notas puede devolver `partial` con `wrote: true`: revisa las
rutas aplicadas, satisfechas, pendientes e inciertas. No hay rollback automático.
El comando no modifica el ledger, staging, commits, conexiones ni Skills.
`sync record` y el respaldo Git se realizan por separado y con su autorización.

La base está implementada, probada y revisada para entrega local; no se ha
publicado ni aplicado sobre una memoria real. Consulta el
[contrato JSON, límites y evidencia](../memoria/project-memory-sync-apply.md) antes de usarla.

## Límites

- No guardar secretos, credenciales, tokens ni datos personales.
- No incluir conocimiento exclusivo de un proyecto.
- Mantener las instrucciones específicas dentro del repositorio o memoria de cada proyecto.
- Revisar y validar cada componente antes de instalarlo.
- Mantener los perfiles generales en modo de solo lectura salvo que exista una necesidad y autorización claras.

## Versionado

La biblioteca se versiona con Git y se respalda en un repositorio privado de
GitHub. Esta publicación manual no añade creación de remotos a la CLI.

## Crear un proyecto limpio

La primera ejecución de `npx nexakit` pregunta «¿Proyecto limpio o ya empezado?». El camino «Ya empezado» prepara
el código existente como antes. «Proyecto limpio» ofrece frontend, backend, base de datos y app móvil; cada parte
permite «No quiero». Con una sola parte se usa la raíz; con varias, `frontend/`, `backend/` y `movil/`.

En una carpeta con archivos, el modo limpio exige una subcarpeta nueva. Antes de crear muestra las órdenes exactas,
los archivos mínimos de FastAPI y los requisitos que falten; un requisito ausente bloquea la confirmación. Usa
los generadores oficiales actuales, instala dependencias y comprueba cada parte antes de continuar con skills,
memoria y agentes. No instala Node/Python del sistema, no levanta bases de datos ni despliega.

Python usa su propio `.venv`. PostgreSQL añade el controlador y `.env.example`; Supabase inicializa su configuración
y añade el cliente al frontend cuando existe, o al backend. Git y el primer commit son opcionales; dentro de otro
repositorio no se crea uno anidado. Lo ya creado se conserva al fallar: se informa la parte, la orden y el registro
`.agent-toolkit/creacion.log`, con los secretos evidentes tachados. No reejecutes sobre los archivos para intentar
sobrescribirlos: revisa el registro y prepara lo existente o usa otra carpeta nueva.

Las respuestas se conservan y no se repite el selector en ejecuciones posteriores. Los generadores trabajan en
una zona temporal propia dentro de `.agent-toolkit` y se trasladan los archivos sin sobrescribir destinos. Tras
un fallo, esa zona se conserva para recuperar lo generado; tras éxito se limpia. Ctrl+C durante una orden la
cancela y conserva lo creado. Véase la [prueba manual](proyecto-limpio-prueba-manual.md).
