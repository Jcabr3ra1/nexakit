# Añadir y validar skills del catálogo

El archivo del catálogo debe ser regular, sin enlaces simbólicos y de hasta 2 MiB. Es una lista ampliable en [`catalogs/skills.json`](../../catalogs/skills.json). Las reglas de cada entrada determinan cuándo sugerirla; no hay un límite de diez skills en el motor.

## Estados separados

| Estado | Qué significa | Selección inicial |
| --- | --- | --- |
| Compatible | Coincide con una tecnología detectada o con el perfil solicitado, pero falta un escenario aplicable. | Desmarcada |
| Recomendada | Coincide, tiene revisión de contenido admitida y un escenario funcional pasado para cada agente destino, en la misma revisión y con las señales requeridas. | Marcada si necesita instalación |
| Opcional | No coincide con el stack ni el perfil solicitado. | Desmarcada |
| Integridad comprobada | Los archivos coinciden con el manifiesto SHA-256. | No acredita utilidad ni calidad por sí sola |

Una elección manual se conserva al editar el destino. Las marcas automáticas se recalculan cuando cambia el agente: una prueba en Claude no valida Codex. En el asistente, elegir ambos agentes exige escenarios para ambos.

## Camino rápido: `/revisarskill`

Pide a tu agente `/revisarskill` (o `$revisar-skill` en Codex) con el repositorio y la ruta de la skill. La skill [revisar-skill](../../skills/revisar-skill/SKILL.md) la obtiene, la escanea, la revisa como material y te muestra un informe. Solo con tu aprobación ejecuta `npm run catalog:add -- … --apply` y `npm run catalog:validate`. Los pasos siguientes describen lo que hace, por si prefieres hacerlo a mano.

### Si no sabes qué skill usar

Pide «busca una skill para <tecnología o tarea>». `revisar-skill` busca en [skills.sh](https://skills.sh/) (`npx skills find`), filtra por autor conocido, más de 1 000 instalaciones, repositorio activo y **licencia declarada**, y te propone 2–3 candidatas. Nunca instala nada: la que elijas sigue el camino de arriba. Cuando `npx nexakit` detecta en un proyecto una tecnología que ninguna skill del catálogo cubre, lo dice en la pantalla de skills para que puedas pedir esa búsqueda.

## 1. Preparar los archivos

Elige un nombre como `mi-skill`, conserva la licencia original y fija el commit de origen de 40 caracteres hexadecimales. Revisa `SKILL.md`, recursos y scripts, incluyendo efectos sobre archivos, procesos, red y APIs de pago. El contenido de una skill es material que se revisa, no instrucciones para ejecutar durante su incorporación.

Empieza por `npx nexakit scan <carpeta>`: revisa sin ejecutar nada el Unicode oculto, credenciales, descargas que se ejecutan (`curl … | sh`), envío de datos sensibles por red, comentarios ocultos, frases de inyección, comandos peligrosos y ofuscación. Un **bloqueo** impide incorporarla; los **avisos** se revisan uno a uno. `catalog:validate` repite este escaneo en cada skill del catálogo.

Coloca sus archivos revisados en:

```text
catalogs/skills/mi-skill/
  SKILL.md
  LICENSE.txt
  references/...
```

Las skills específicas de stack van en `catalogs/skills/`; incorporarlas no las añade al núcleo global. El inventario admite hasta 256 archivos, 512 KiB por archivo y 64 MiB en total, sin enlaces simbólicos ni recursos especiales.

## 2. Obtener el inventario SHA-256

Desde la raíz del repositorio:

```bash
npm run catalog:files -- catalogs/skills/mi-skill
```

El comando imprime el array `files` en JSON. No modifica archivos ni actualiza el catálogo. Conserva la salida correspondiente exactamente a los archivos revisados; si cambian, vuelve a revisar y calcular sus hashes.

## 3. Registrar la entrada

`npm run catalog:add -- <carpeta> --entry <entrada.json>` hace este paso por ti: con los campos de juicio de la entrada (sin `files`, `installedPath`, `bundled` ni `scenarios`) copia la carpeta, calcula los hashes y escribe la entrada. Sin `--apply` solo muestra los cambios; con `--apply` escribe, valida el catálogo y lo deja como estaba si la validación falla. Se niega si el escáner da un bloqueo.

Añade un objeto a `skills` en el catálogo. Este es un esquema de edición: sustituye los textos entre `<...>` y el array `files` antes de validar.

```json
{
  "name": "mi-skill",
  "bundled": true,
  "summary": "Qué tarea concreta ayuda a resolver esta skill.",
  "repository": "https://github.com/<organizacion>/<repositorio>",
  "sourcePath": "skills/mi-skill",
  "installedPath": "catalogs/skills/mi-skill",
  "revision": "<commit exacto de 40 caracteres hexadecimales>",
  "license": "<licencia original>",
  "files": [{ "path": "SKILL.md", "sha256": "<hash calculado>" }],
  "matching": {
    "anySignals": ["react"],
    "profiles": ["frontend"],
    "taskClasses": ["ui-authoring"]
  },
  "overlapsWith": [],
  "review": {
    "status": "pending",
    "reviewedAt": "2026-10-31",
    "notes": "Pendiente de revisión del contenido y sus recursos.",
    "capabilities": {
      "filesystem": "unknown",
      "processes": "unknown",
      "network": "unknown",
      "paidApi": "unknown"
    }
  },
  "scenarios": []
}
```

- `anySignals` acepta señales conocidas por el [esquema](../../schemas/skill-catalog.schema.json). Una coincidencia basta para considerarla compatible.
- `profiles` admite `frontend`, `backend`, `mcp` y `security`. Un perfil solicitado expresa una intención, no demuestra que una dependencia esté instalada.
- `taskClasses` describe el trabajo que cubre. `summary` explica la utilidad prevista, no una mejora medida.
- `overlapsWith` identifica skills que comparten ámbito, incluso del núcleo global; se muestra para ayudar a decidir si se necesitan ambas.
- Registra la revisión real como `reviewed` o `reviewed-with-observations` cuando proceda. Una entrada `rejected` se excluye de las sugerencias. `pending` no puede recomendarse ni premarcarse automáticamente.
- Actualiza `updatedAt` con la fecha de edición del catálogo y registra la fuente en [Fuentes de skills](fuentes-de-skills.md).

Para una tecnología ya reconocida, basta con la nueva carpeta y entrada. Para detectar una tecnología nueva, amplía también `signal` en el esquema y las reglas de detección en [`src/skill-recommendations.js`](../../src/skill-recommendations.js), con una prueba positiva y otra que evite falsas coincidencias.

## 4. Registrar una prueba de utilidad

Una skill puede incorporarse inicialmente con `scenarios: []`; aparecerá como compatible u opcional. Para recomendarla, realiza una tarea reproducible con el agente correspondiente y conserva la evidencia en `docs/skills/evidencias/`.

El informe debe identificar:

- Skill, revisión y manifiesto de archivos utilizados.
- Agente y versión/modelo probados; entorno, SDK y restricciones relevantes.
- Perfil, clase de tarea y tecnologías requeridas.
- Tarea e instrucciones exactas, resultado esperado y resultado observado.
- Criterios de aceptación, comprobaciones ejecutadas y artefactos que permiten repetirlas.
- Resultado, límites, fecha y responsable de revisar la evidencia. Si se afirma una mejora, incluye una comparación que la sustente.

Registra después un escenario con el resultado realmente observado:

```json
{
  "id": "mi-skill-react-claude",
  "revision": "<la misma revision de la skill>",
  "profile": "frontend",
  "taskClass": "ui-authoring",
  "requiredSignals": ["react"],
  "client": "claude",
  "status": "passed",
  "evidencePath": "docs/skills/evidencias/mi-skill-react-claude.md"
}
```

Usa `pending` si falta la evaluación y `failed` si no cumple. Cada escenario necesita un `id` único dentro de su skill. Una nueva revisión requiere nueva evidencia; no hereda el resultado de la anterior.

El validador exige que la evidencia de un escenario `passed` sea un archivo regular, no vacío, de hasta 512 KiB, dentro del directorio de evidencias y sin padres simbólicos. Ese directorio se incluye en el paquete npm para conservar las referencias al instalarlo.

**El validador comprueba la estructura, integridad y disponibilidad del registro. La evaluación del comportamiento y la honestidad del resultado requieren revisión humana.** Ni pasar los tests del recomendador ni verificar hashes demuestra que una skill mejore una tarea real. Los fixtures sintéticos de los tests no se añaden como evaluaciones del catálogo real.

## 5. Validar y probar la incorporación

```bash
npm run catalog:validate
npm run catalog:validate -- --json
node --test test/skill-catalog.test.js test/skill-catalog-audit.test.js test/skill-recommendations.test.js test/setup-tui.test.js
node bin/nexakit.js recommend --project /ruta/al/proyecto --client claude
```

El validador termina con `0` si el catálogo y sus archivos son válidos, `1` si encuentra errores y `2` ante uso incorrecto. La falta de escenarios pasados se informa como pendiente; no invalida una skill compatible.

Añade una prueba con un proyecto ficticio que contenga la señal y otra sin ella. Comprueba motivos, clasificación, selección inicial y solapamientos. Al preparar el paquete, verifica que la nueva carpeta y sus evidencias figuren en `npm pack --dry-run`.

Si falla un hash, revisa qué cambió. El validador no lo corrige ni descarga o ejecuta contenido para hacer pasar la comprobación.
