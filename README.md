<div align="center">

<img src="assets/brand/nexakit-readme-hero.png" alt="NexaKit: un comando para preparar tus skills, tu memoria y tus agentes con Claude Code, Codex y Antigravity" width="100%">

# NexaKit

**Tus skills. Tu memoria. Tus IA trabajando juntas.**

[Guía interactiva en 3 pasos](docs/guias/guia-de-comandos.html) · [Documentación](docs/README.md) · [Catálogo](catalogs/skills.json)

</div>

Detecta las tecnologías de tu proyecto (en manifiestos, subcarpetas y `README.md`), sugiere skills compatibles, crea o conecta la memoria del proyecto en Obsidian y deja listas tus IA —**Claude Code, Codex y Antigravity CLI**— con una sola confirmación.

```bash
npx nexakit
```

## Inicio en tres pasos

1. **Requisitos.** Instala **Node.js 24 o superior**, Git y al menos uno de los tres clientes de IA (**Claude Code**, **Codex** o **Antigravity CLI**).
2. **Ejecuta `npx nexakit` en tu proyecto.** Responde tres preguntas breves (skills para el proyecto, memoria en Obsidian e IA donde dejarlo listo) y confirma una sola vez. Con `npx nexakit --si` aplica directamente las opciones sugeridas.
3. **Reinicia tu agente y trabaja con normalidad.** No necesitas ningún comando especial para empezar a programar:
   - **Revisión automática:** al terminar una tarea con cambios de código, la IA pide automáticamente una revisión en solo lectura a otra IA. La primera vez pregunta `«¿A dónde mando la revisión?»` marcando la recomendada; si dices `«sin revisión»`, la omite, y con `/revisar` (o `$revisar`) pides una revisión adicional cuando quieras.
   - **Seguimiento automático y cierre:** si una tarea larga queda a medias, escribe o actualiza la nota de seguimiento en la bóveda con `project-handoff`, y al fusionar el cambio se cierra con `/cerrar-memoria` (o `$cerrar-memoria`).

## Comandos

```bash
npx nexakit                                    # Preparar el proyecto (3 preguntas y una confirmación)
npx nexakit --si                               # Aplicar directamente las sugerencias
npx nexakit comprobar                          # Comprobar que todo esté bien conectado
npx nexakit quitar                             # Ver qué quitaría del proyecto y de tus IA
npx nexakit quitar --si                        # Quitar lo que nexakit instaló
npx nexakit reparar --desde <ruta>             # Reparar enlaces que apuntan a una copia antigua
npx nexakit memoria <subcomando>               # Operaciones avanzadas de memoria (status, doctor, sync…)
npx nexakit setup --omitir <skill> --apply   # Declarar quitada una skill global que ya no enlazas
npx nexakit setup --reponer <skill> --apply  # Devolver una skill global que quitaste
~/.nexakit/nexakit revision --disponibles --principal <ia>  # Ver IA revisoras certificadas
~/.nexakit/nexakit modelo                      # Ver catálogo real de modelos y esfuerzos
```

Si quitas a mano el enlace de una skill global que nexakit instaló, `npx nexakit` no la vuelve a crear en esa IA. `frontend-design`, `web-design-guidelines` y `mcp-builder` ya no forman parte de la base global: se instalan por proyecto cuando se detecta su stack.

También puedes instalarlo globalmente con `npm install -g nexakit` y ejecutar `nexakit`. El alias `agent-toolkit` y los subcomandos anteriores (`recommend`, `doctor`, `setup`, `detach`) siguen disponibles por compatibilidad.

## Tecnologías detectadas

NexaKit inspecciona la raíz y las subcarpetas inmediatas del proyecto (`package.json`, `pyproject.toml`, `requirements.txt`, `src-tauri/` y `README.md`):

- **Frontend:** React, Next.js, Tailwind CSS, Astro, Vue y Svelte.
- **Backend y APIs:** Express, Fastify, Hono, Django, FastAPI, Flask y API REST / OpenAPI.
- **Escritorio:** Tauri.
- **Datos:** Supabase, PostgreSQL, Prisma y Drizzle.
- **MCP:** SDK de Model Context Protocol y FastMCP.
- **Pruebas:** Playwright (además de reconocer señales como Node.js, TypeScript y Vitest).

## Skills con contexto

El catálogo incluido contiene **10 skills** con revisión de origen y hashes SHA-256. NexaKit muestra el motivo concreto de cada sugerencia (por ejemplo, qué archivo o `README.md` la activó). Consulta las [fuentes y licencias](docs/skills/fuentes-de-skills.md) o aprende a [ampliar el catálogo](docs/skills/ampliar-catalogo.md).

## Más herramientas

- **Revisión entre IA en solo lectura.** Aislamiento certificado y procedencia verificada entre Claude Code, Codex y Antigravity. [Flujo de revisión](docs/agentes/coordinacion/revision-entre-ia.md).
- **Memoria por proyecto.** Contexto separado del código y conectado en solo lectura mediante MCP, con seguimiento de tareas largas y cierre con `/cerrar-memoria`. [Crear una memoria](docs/memoria/project-memory-init.md).
- **Guía interactiva.** Los tres pasos de inicio, buscador de comandos copiables y resolución de problemas. Abre [la guía HTML](docs/guias/guia-de-comandos.html) en tu navegador.
- **Catálogo ampliable.** Incorpora skills y comprueba sus archivos con `npm run catalog:validate`. [Añadir una skill](docs/skills/ampliar-catalogo.md).

## Requisitos

**Node.js 24 o superior** y una terminal interactiva para el asistente (o `--si` en modo no interactivo).

Para contribuir: [desarrollo local, pruebas y empaquetado](docs/guias/desarrollo.md).

## Licencia

[MIT](LICENSE). Las skills incorporadas conservan sus licencias originales.
