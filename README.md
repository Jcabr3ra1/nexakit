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
2. **Ejecuta `npx nexakit` en tu proyecto.** Responde tres preguntas breves (skills para el proyecto, memoria en Obsidian e IA donde dejarlo listo; con Claude Code, una cuarta para elegir los mods) y confirma una sola vez. Con `npx nexakit --si` aplica directamente las opciones sugeridas.
3. **Reinicia tu agente y trabaja con normalidad.** No necesitas ningún comando especial para empezar a programar:
   - **Orquesta por niveles:** la sesión principal entiende, planifica e integra, y delega la ejecución en subagentes de nivel (ligero, normal, exigente y alto) con su propio modelo y esfuerzo. El plugin `niveles` trae además seis especialistas por tarea, cada uno con su tope de pasos y sus herramientas limitadas: `investigador` (solo lee y busca en fuentes oficiales, máximo 25 pasos), `revisor-de-calidad` (dictamen con la puerta de calidad, sin editar), `cierre-de-memoria` (cierra la memoria y registra cada PR), `subir-al-repo` (commit, push, PR, espera del CI y fusión, solo con tu «sube al repo» escrito en el encargo; la sesión principal verifica después que quedó bien), `sincronizador-docs` (tras un PR, señala qué afirmaciones de la documentación ya no son ciertas) y `cazador-de-flakes` (mira el historial del CI para decir si un fallo es intermitente). Conviene delegar solo cuando la tarea lee mucho o devuelve mucho ruido: lanzar un subagente tiene un coste fijo, y para una tarea pequeña sale más barato hacerla en la sesión principal. En la barra cada uno aparece con su nombre, su modelo real, su estado y sus tokens. El modo tutor, en el que tú escribes el código, solo se activa si lo pides.
   - **Revisión por otra IA, solo cuando la pides:** escribe `/revisar` (o `$revisar`) o di «que lo revise <IA>». La primera vez pregunta `«¿A dónde mando la revisión?»` marcando la recomendada; nunca se lanza sola.
   - **Seguimiento automático y cierre:** si una tarea larga queda a medias, escribe o actualiza la nota de seguimiento en la bóveda con `project-handoff`, y al fusionar el cambio se cierra con `/cerrar-memoria` (o `$cerrar-memoria`).

## Comandos

```bash
npx nexakit                                    # Preparar el proyecto (3 preguntas, 4 con Claude Code, y una confirmación)
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
~/.nexakit/nexakit ahorro                      # Cuánta salida de comandos recortó nexakit-ahorro
~/.nexakit/nexakit codex auditar               # Revisar contexto y recomendaciones de Codex
~/.nexakit/nexakit codex consumo               # Contadores registrados por los hooks de Codex
~/.nexakit/nexakit lecciones                   # Correcciones, lecciones guardadas y pendientes
npx nexakit memoria allow-dir <bóveda> --apply # Permitir a Claude Code abrir la memoria desde el proyecto
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

**Codex:** `nexakit codex` audita contexto, prepara hooks de medición, recorta
salidas con un ejecutor explícito y compara muestras de consumo. La preparación
muestra una vista previa; la activación se revisa por separado y respeta tu
configuración. [Guía de ahorro y consumo](docs/guias/codex-ahorro.md).

Los mods de Claude Code se instalan *dentro* de Claude Code: `/plugin marketplace add Jcabr3ra1/nexakit` y luego `/plugin install <nombre>@agent-toolkit` para `niveles`, `nexakit-modelo`, `nexakit-sesion`, `nexakit-ahorro`, `nexakit-lecciones` y `nexakit-guardarrailes` ([paso 7 de la guía](docs/guias/guia-de-comandos.md#7-instala-los-plugins-y-mods-solo-claude-code)).


- **Revisión entre IA en solo lectura.** Aislamiento certificado y procedencia verificada entre Claude Code, Codex y Antigravity. [Flujo de revisión](docs/agentes/coordinacion/revision-entre-ia.md).
- **Memoria por proyecto.** Contexto separado del código y conectado en solo lectura mediante MCP, con seguimiento de tareas largas y cierre con `/cerrar-memoria`. [Crear una memoria](docs/memoria/project-memory-init.md).
- **Barra de modelo y uso.** El mod `nexakit-modelo` dibuja sobre el prompt el modelo y el esfuerzo, la recomendación para cada mensaje (sin cambiar nada), el acierto de caché y el contexto y los límites con colores; cuando el límite de 5 h o el semanal va en ámbar o en rojo, añade cuándo se reinicia (`sem 92% ↻ vie 10:00`), en tu hora local. La recomendación aparece mientras escribes y elige la salida más barata: ajustar el esfuerzo, delegar en un subagente, cambiar de modelo solo cuando no cuesta caché, o abrir una sesión nueva. Cada subagente en marcha ocupa una fila con su nivel, su modelo real, su encargo y sus tokens (`48k nuevos · 97% caché (148k en total)`): los tokens nuevos (entrada nueva, escritura en caché y salida), que son los que informa el sistema al terminar el subagente y los que más pesan en la cuota; el porcentaje que fue lectura barata de caché; y, atenuado, el total que procesó, que puede ser de millones. Se actualiza en cada paso del subagente. El porcentaje aparece desde el segundo paso, porque el primero siempre escribe la caché. No equivale exactamente a lo que gasta de tu cuota de 5 h, que sigue marcando el indicador `5h`.
- **Aviso de sesión.** El mod `nexakit-sesion` avisa al 60 % y al 80 % de contexto cuándo conviene abrir una sesión nueva, pide delegar en serie cuando la cuota de 5 h pasa del 70 % y, al compactar, indica al resumen qué no puede perder (rama, archivos, decisiones, pendientes y comprobaciones).
- **Aprender de los errores.** El mod `nexakit-lecciones` frena un comando que acaba de fallar igual (si nada cambió desde entonces), pide parar y cambiar de enfoque cuando el mismo tipo de error sale tres veces, y cuando un mensaje tuyo corrige algo pide guardar la lección en la memoria persistente de Claude. Apunta las correcciones y, si alguna quedó sin guardar, la recuerda una vez en la sesión siguiente; `nexakit lecciones` las resume. Para repetir a propósito, pon `NEXAKIT_REPETIR=1` delante del comando.
- **Ahorro de tokens.** El mod `nexakit-ahorro` recorta la salida larga de los comandos (más de 120 líneas) a su principio, su final y las líneas con fallos, y guarda la completa en `~/.nexakit/salidas/`. Para verla entera, pon `NEXAKIT_SALIDA=completa` delante del comando. `nexakit ahorro` resume cuánto se recortó.
- **Guardarraíles.** El mod `nexakit-guardarrailes` bloquea comandos destructivos de Bash, la escritura de archivos sensibles o de contenido que reconoce como secreto, y los commits con mensajes que se apartan de Conventional Commits. [Reglas y excepciones](plugins/nexakit-guardarrailes/README.md).
- **Guía interactiva.** Los tres pasos de inicio, buscador de comandos copiables y resolución de problemas. Abre [la guía HTML](docs/guias/guia-de-comandos.html) en tu navegador.
- **Catálogo ampliable.** Incorpora skills y comprueba sus archivos con `npm run catalog:validate`. [Añadir una skill](docs/skills/ampliar-catalogo.md).

## Requisitos

**Node.js 24 o superior** y una terminal interactiva para el asistente (o `--si` en modo no interactivo).

Para contribuir: [desarrollo local, pruebas y empaquetado](docs/guias/desarrollo.md).

## Licencia

[MIT](LICENSE). Las skills incorporadas conservan sus licencias originales.

### Empezar desde una carpeta vacía

Ejecuta `npx nexakit` y elige **Proyecto limpio**. Selecciona frontend, backend, base de datos o app móvil; las
partes son opcionales. NexaKit muestra las órdenes y requisitos antes de descargar los generadores oficiales,
instalar las dependencias y comprobar lo creado. Después continúa con skills, memoria y agentes.

Una sola parte ocupa la raíz; varias usan `frontend/`, `backend/` y `movil/`. Si ya hay archivos, exige una
subcarpeta nueva. Git es opcional. Ante un fallo conserva lo creado y el registro `.agent-toolkit/creacion.log`.
Lee la [guía de uso](docs/guias/uso.md#crear-un-proyecto-limpio) y la
[comprobación manual](docs/guias/proyecto-limpio-prueba-manual.md).
