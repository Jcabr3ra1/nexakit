# Cambios

## 0.11.0

### La fábrica de revisión

Nueva forma de revisar un cambio con varias IA, solo cuando la pides (`/fabrica` o «pásalo por la fábrica»).

- La fábrica propone un recorrido por estaciones (seguridad, arquitectura, pruebas, código, interfaz, rendimiento y documentación), cada una con la IA, el modelo y el esfuerzo que le encajan entre Claude, Codex y Antigravity.
- Nada se lanza sin tu aprobación: el recorrido lleva una huella que debe coincidir con el `HEAD` y el diff actuales.
- Las IA externas trabajan en solo lectura: se deniegan los cambios de archivos y los permisos de escritura, y las órdenes solo se aprueban si la estación las declara. Tras cada recorrido se comprueba que el repo no cambió.
- Hasta 4 estaciones externas a la vez y 15 minutos como máximo cada una. Sin bucles de espera, disparadores externos ni fusión automática.
- El rastro de cada recorrido queda en `~/.nexakit/fabrica/<repo>/<id>/` con permisos restringidos y poda a los 90 días.
- Se usa desde la skill `fabrica`, desde el servidor MCP `nexakit-fabrica` (`nexakit-fabrica-mcp`) o con `nexakit fabrica proponer|lanzar|estado|resultado|cancelar`. Más detalle en [docs/agentes/coordinacion/fabrica.md](docs/agentes/coordinacion/fabrica.md).
- Prueba opcional contra Codex y Antigravity reales: `NEXAKIT_FABRICA_REAL=1 node --test test/fabrica-real.test.js` (gasta tokens).

### Se retira

La fábrica sustituye al flujo de encargos, a la bandeja entre terminales y a la revisión por otra IA.

- La orden `/revisar` y la skill `revisar`.
- `nexakit revision`: ahora responde que la orden está retirada.
- Los binarios `agent-task`, `agent-toolkit-mcp` y `agent-toolkit-inbox`, con sus módulos, esquemas, ejemplos, pruebas y documentos.
- La bandeja entre terminales.

### Migración automática

Al ejecutar `npx nexakit` en una instalación anterior, el plan de instalación incluye:

- Retirar el MCP antiguo `agent-toolkit-mcp` de Claude Code y de Codex, y registrar `nexakit-fabrica` en su lugar. Si no encuentra el cliente, avisa y no toca nada.
- Retirar los restos de los flujos retirados: `~/.agent-toolkit/workflows` y `~/.nexakit/revisores.json`, solo si son una carpeta o un archivo reales (nunca se siguen enlaces). `~/.agent-toolkit/gemini` pertenece a las herramientas de Gemini y no se toca.
- Actualizar los agentes de Codex que aún llevan la marca antigua, solo los que se comprueba que son de NexaKit.

`nexakit comprobar` (alias `doctor`) avisa de lo que la migración haría, sin aplicarlo.
