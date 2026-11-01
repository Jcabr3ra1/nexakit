# Skills recomendadas para Agent Toolkit

Investigación: 2026-10-28. Selección por contenido publicado por sus autores,
encaje con el trabajo y solapamiento con las skills disponibles. Se consultaron
los archivos SKILL.md originales de las candidatas y los repositorios enlazados.
La selección no equivale a una prueba comparativa de eficacia ni a una instalación.

## Punto de partida

El entorno actual ya ofrece Superpowers, Impeccable, UI UX Pro Max, Figma y
use-railway, entre otras skills. Que estén disponibles en este entorno no
significa que se distribuyan con Agent Toolkit. La biblioteca local contiene
procedimientos propios de requisitos, calidad, traspasos y organización.

Después de esta investigación, el usuario solicitó e incorporó
[frontend-design de Claude Code Templates](../../skills/frontend-design/SKILL.md)
para este proyecto. Su revisión y enlaces de instalación están en el
[registro de fuentes](fuentes-de-skills.md#frontend-design--claude-code-templates).

También se incorporó a solicitud del usuario
[web-design-guidelines de Vercel](../../skills/web-design-guidelines/SKILL.md),
para revisar código de interfaz y accesibilidad. Complementa frontend-design:
una orienta la creación y la otra aporta criterios de revisión de UI.

El package.json actual de Toolkit describe herramientas Node.js y servidores MCP;
no declara una aplicación React ni una base de datos Postgres. Por eso conviene
elegir especializaciones según el proyecto que las necesite.

## Selección

| Área | Skill y fuente original | Qué aporta | Prioridad propuesta |
| --- | --- | --- | --- |
| Diseño | [Impeccable — Paul Bakaus](https://github.com/pbakaus/impeccable) | Diseño, crítica, accesibilidad y acabado de interfaces. | Ya disponible en este entorno; aprovechar antes de sumar más guías similares. |
| Herramientas para agentes | [mcp-builder — Anthropic](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/SKILL.md) | Diseño de herramientas MCP, esquemas de entrada y salida, errores y evaluación. | Alta para el Toolkit actual. |
| Seguridad | [differential-review — Trail of Bits](https://github.com/trailofbits/skills/blob/main/plugins/differential-review/skills/differential-review/SKILL.md) | Revisión de cambios con contexto Git, dependencias, cobertura y escenarios de ataque. | Incorporada; evaluación inicial acotada registrada. |
| Diseño de APIs | [api-design-principles — wshobson/agents](https://github.com/wshobson/agents/blob/main/plugins/backend-development/skills/api-design-principles/SKILL.md) | Contratos REST/GraphQL, paginación, errores y versionado. | Para proyectos que expongan APIs HTTP. Fuente comunitaria. |
| Backend Node.js | [nodejs-backend-patterns — wshobson/agents](https://github.com/wshobson/agents/blob/main/plugins/javascript-typescript/skills/nodejs-backend-patterns/SKILL.md) | Patrones de servicios Node, Express/Fastify, validación, autenticación y cierre de procesos. | Para construir servicios web Node. Fuente comunitaria. |
| Bases de datos | [supabase-postgres-best-practices — Supabase](https://github.com/supabase/agent-skills/blob/main/skills/supabase-postgres-best-practices/SKILL.md) | Consultas, índices, conexiones, esquemas y seguridad RLS en Postgres. | Cuando el proyecto use Postgres, también fuera de Supabase. |
| Frontend React | [vercel-react-best-practices — Vercel](https://github.com/vercel-labs/agent-skills/blob/main/skills/react-best-practices/SKILL.md) | Rendimiento de React/Next.js: carga de datos, bundles, servidor y renderizado. | Cuando el proyecto use React o Next.js. |
| Pruebas de interfaz | [webapp-testing — Anthropic](https://github.com/anthropics/skills/blob/main/skills/webapp-testing/SKILL.md) | Pruebas de aplicaciones web locales con Playwright, capturas y registro de consola. | Cuando exista una interfaz web comprobable. |

## Recomendación

Prioridad reiterada por el usuario el 2026-10-28: **MCP Builder y seguridad**.
Ambas están incorporadas con [evaluación inicial acotada](evidencias/2026-10-28-evaluacion-inicial-mcp-seguridad.md).
La evaluación funcional general sigue pendiente. El contexto tecnológico y el siguiente
resultado de cada pendiente están en
«Stack actual y prioridades», en la memoria de Obsidian de NexaKit (`03-IMPLEMENTACION/Planes/2026-10-28-stack-y-prioridades.md`).

Para el Toolkit actual, evaluar primero mcp-builder y differential-review en
tareas reales acotadas. Para el catálogo reutilizable, incorporar después perfiles
de backend/API y base de datos según el stack de cada proyecto. Impeccable cubre
el diseño visual; la skill de Vercel complementa la implementación y rendimiento.

Conservar un núcleo común y especializaciones opcionales permite aprovechar
las fuentes originales sin imponer a todos los proyectos la misma tecnología.
Las guías Node y MCP contienen preferencias de stack; no justifican por sí solas
convertir el código JavaScript actual de Toolkit a TypeScript o Express.

## Condiciones observadas para una futura adopción

- mcp-builder y webapp-testing se publican en la colección de Anthropic; sus
  licencias por skill son [Apache-2.0 para MCP](https://github.com/anthropics/skills/blob/main/skills/mcp-builder/LICENSE.txt)
  y [Apache-2.0 para pruebas web](https://github.com/anthropics/skills/blob/main/skills/webapp-testing/LICENSE.txt).
- Las dos candidatas de wshobson son comunitarias. Su repositorio publica una
  [licencia MIT](https://github.com/wshobson/agents/blob/main/LICENSE).
- La colección de Trail of Bits publica
  [CC BY-SA 4.0](https://github.com/trailofbits/skills/blob/main/LICENSE).
  La forma de distribuir o adaptar su contenido se debe definir por separado.
- Las skills de Supabase y Vercel declaran MIT en los archivos consultados;
  Impeccable publica Apache-2.0 en su repositorio.
- webapp-testing propone Python y Playwright para pruebas locales. En una sesión
  con herramientas de navegador proporcionadas por el cliente, la integración
  debe respetar esas herramientas y distinguir inspección de UI de pruebas del
  proyecto; no asumir compatibilidad solo por compartir el nombre Playwright.
- Antes de adoptar una candidata, revisar también sus referencias y scripts,
  fijar una revisión y evaluarla contra un encargo real. En esta investigación
  se revisaron los puntos de entrada, no se ejecutaron esos recursos.

Los enlaces a main son mutables. MCP Builder y Differential Review se incorporaron
desde revisiones fijadas en el registro de fuentes; las otras candidatas de la
tabla continúan investigadas para evaluación, sin instalación.

## Referente para un recomendador: AutoSkills

Consulta: 2026-10-28. El usuario propone recomendar skills existentes con evidencia
de calidad y seguridad, tomando como referencia
[midudev/autoskills](https://github.com/midudev/autoskills).

Según su [documentación](https://github.com/midudev/autoskills#security-model),
detecta tecnologías del proyecto y selecciona skills de un catálogo propio,
sin descargarlas directamente de repositorios de terceros durante la instalación.
Sus mantenedores describen revisión con IA ante inyección de instrucciones y
riesgos de cadena de suministro, hashes SHA-256 por archivo y un skills-lock.json.
Estas afirmaciones se consultaron en su documentación; no se ejecutó AutoSkills
ni se realizó una auditoría de su implementación.

La revisión de seguridad, la integridad y la eficacia responden a preguntas
distintas. Un hash coincidente acredita coincidencia con el contenido esperado;
una revisión analiza comportamientos potenciales; una prueba funcional registra
si una revisión concreta resolvió una tarea en un entorno definido. Ninguna de
esas evidencias se debe presentar como garantía universal de seguridad.

Recomendación del agente, pendiente de diseño y aprobación:

1. Mantener un catálogo pequeño de skills originales seleccionadas por su encaje
   con el proyecto, aprovechando registros externos como fuente de candidatas.
2. Registrar separadamente procedencia, revisión de contenido y scripts, versión,
   hashes, licencia, fecha, compatibilidad y pruebas con resultados reproducibles.
3. Mostrar qué está instalado, qué aporta cada recomendación y qué se solapa con
   skills existentes. La detección del stack prepara una recomendación revisable.
4. Instalar la selección autorizada desde revisiones fijadas y reevaluar cambios
   posteriores antes de darles el mismo estado de revisión o prueba.

Las skills instaladas en esta sesión tienen comprobaciones de procedencia,
integridad y formato; no se afirma que hayan pasado una auditoría exhaustiva ni
una evaluación funcional completa en todos los clientes.

Dos alternativas de integración: adoptar AutoSkills como herramienta externa
opcional, o desarrollar el catálogo de Toolkit usando fuentes originales y
evidencia propia. La primera aprovecha su detección y catálogo; la segunda
permite conservar el flujo y los criterios de Toolkit con más mantenimiento.
El [proyecto declara CC BY-NC 4.0](https://github.com/midudev/autoskills/blob/main/LICENSE);
antes de incorporar su código o catálogo hay que definir la compatibilidad del
uso previsto con esa licencia. Cada skill original conserva su propia licencia.

Se recomienda empezar con el catálogo de Toolkit y evaluar después un adaptador
opcional de AutoSkills. La idea reutiliza skills existentes; no presupone copiar
el motor o redistribuir el catálogo externo.
