# Tu primera prueba con NexaKit

Esta guía te permite comprobar la base local sin conectar cuentas, modificar un
proyecto ni gastar cuota de IA. Después podrás
decidir qué memoria o encargo real quieres preparar.

## 1. Comprueba tu copia

Abre una terminal en la raíz de **Agent-Toolkit**, donde están `package.json`,
`bin/` y `examples/`. No ejecutes estos pasos dentro del backend de otro proyecto.

Si ya tienes la biblioteca local, usa esa copia revisada. La [beta R1](../operacion/agent-toolkit-private-beta.md)
ya está publicada en GitHub privado; para clonar, utiliza únicamente la URL
privada confirmada para ti. Clonar no incorpora correcciones o documentación
todavía pendientes de commit y publicación. Esta guía no realiza la clonación
ni un push.

```bash
git status --short
node --version
```

Un checkout limpio muestra salida vacía en el primer comando. Si hay cambios
que no reconoces, consérvalos y solicita revisión; no los borres para seguir.
El segundo muestra tu versión de Node.js, el programa que ejecuta la herramienta.

El paquete declara Node.js 24 (`^24.0.0`). R1 se comprobó en macOS con dependencias
existentes; [R2](../operacion/agent-toolkit-clean-install.md) validó una copia nueva con
dependencias propias en macOS/arm64, Node.js `v24.14.1` y npm `11.11.0`.
No certifica todas las versiones o sistemas operativos, ni una máquina sin
herramientas previas. La revisión R2 incluye una corrección de prueba y su cierre
aprobado para consolidación local; la publicación requiere autorización aparte.
No atribuyas esa revisión final a una copia antigua.

También necesitas las dependencias de esta copia, incluido Ajv. Si faltan,
detente y prepara la instalación local con un alcance separado; consulta la
[guía técnica](uso.md). Esta prueba no instala dependencias, comandos globales
o clientes de IA por su cuenta. No necesitas añadir API keys para estos ejemplos.

## 2. Descubre las dos herramientas

```bash
node bin/project-memory.js --help
node bin/nexakit.js --help
```

- `project-memory` trabaja con memorias de proyecto: crear, diagnosticar,
  preparar conexiones y revisar cambios con controles.
- `nexakit` deja listas tus IA y consulta modelos y consumo. Su orden
  `nexakit fabrica` propone y lanza una revisión por otras IA; el agente la usa
  por su cuenta al cerrar tareas con código y antes de un PR.

Se espera la ayuda de cada herramienta y exit 0. Estos comandos no crean una
bóveda, conectan clientes ni consultan una cuenta. Usar `node bin/...` evita
suponer que ya instalaste un comando global.

## 3. Entiende cómo se pide una revisión

La revisión por otras IA la lanza el agente por su cuenta al cerrar una tarea con
código y antes de un PR; también puedes pedirla con `/fabrica` (o `$fabrica` en
Codex). Propone un recorrido, con las IA, los modelos y el coste en llamadas, y lo
lanza con su huella; solo pide tu aprobación si trae órdenes del repo revisado.
Las IA externas leen el diff sin escribir. Consulta [la fábrica de revisión](../agentes/coordinacion/fabrica.md)
antes de usarla con un proyecto real; esta guía no la ejecuta.

## 4. Elige el siguiente uso real

No tienes que hacerlo todo a la vez:

- Para una memoria nueva: empieza por la vista previa de
  [project-memory init](../memoria/project-memory-init.md). Crear y conectar son pasos
  diferentes; no copies datos de otra bóveda.
- Para aprender programando: usa un [encargo tutor](../../templates/agent-team/README.md).
  El agente explica, tú escribes y se revisa el resultado.
- Para delegar: delimita archivos, criterios y permisos. Un encargo autónomo
  sigue necesitando autorización y entrega manual a cada participante.

Un encargo real vive en una carpeta privada acordada, no en los ejemplos
versionados. Antes de compartirlo, revisa su contenido y el permiso del receptor.
Actualizar Obsidian, instalar conexiones, hacer commits o publicar no se
autoriza por haber completado esta prueba.

## Estado de esta guía

R1 cerró documentación, recorrido integrado ficticio y publicación privada.
R2 verificó instalación de cinco paquetes propios desde la lockfile, ayudas,
ejemplo, integración 1/1 y regresión 3.282/3.282 en el candidato corregido.
La evidencia, los intentos anteriores y los límites están en
[Validación desde una copia nueva](../operacion/agent-toolkit-clean-install.md).

Completar estos pasos no ejecuta automáticamente un equipo, no conecta clientes
reales ni acredita suscripción, disponibilidad o políticas de consumo. El cierre
de R2 no publica por sí solo los archivos pendientes ni reemplaza su revisión.

## Instalación y recuperación

Consulta [Consolidación](consolidacion.md) para `doctor`, instalación de skills,
el consumo de Codex y de Gemini. Son comandos adicionales a los
ejemplos ficticios de esta guía; no necesitas llamar a ningún modelo para probar
`doctor`, las vistas previas, `consumo` o el historial local de Gemini.
