# R3.3 — Revisión de adopción y propuesta de lectura con Codex

## Estado y alcance

Propuesta del 2026-10-11 (America/Bogota), sobre la fuente `e659337`.
La revisión de utilidad es local y de solo lectura. La conexión no está aprobada,
instalada ni probada. No se ejecutaron clientes nativos o consultas de cuentas.
Este documento no cierra ni modifica el borrador histórico de R3.1/R3.2.

## Resultado de la revisión de utilidad

Las cuatro notas preparadas en R3.2 permiten recuperar contexto acotado:

| Pregunta | Nota consultada | Resultado |
| --- | --- | --- |
| ¿Para qué sirve la herramienta? | Producto | Organizar contexto y coordinar trabajo; no es un chatbot autónomo |
| ¿Qué está disponible? | Producto y Arquitectura | CLI de memoria, preparación de encargos y comparación de archivos |
| ¿Qué sigue manual? | Producto y Estado actual | Entrega de encargos y revisión; no se inicia una IA al preparar un borrador |
| ¿Qué falta comprobar? | Estado actual y Entregas | Conexión real, respaldo y admisión nativa; R2 aporta evidencia fechada de pruebas |

Las fuentes y fechas están indicadas. Las otras notas siguen como plantilla,
no como áreas auditadas. Esta lectura directa no demuestra que una IA haya usado
MCP ni que la Skill esté disponible en un cliente. La adopción local y la
integración se evalúan por separado.

## Primer cliente propuesto

Codex, por su función de coordinación en el piloto. No se extiende esta propuesta
a Claude o Gemini. La autorización debe indicar el destino físico privado;
las rutas de la máquina no se incorporan a esta biblioteca.

La documentación oficial describe configuración MCP compartida en el mismo host,
servidores STDIO y `enabled_tools` como lista de herramientas permitidas.
Por ello, cambiar configuración personal puede afectar más de una superficie
local, no solamente una sesión del CLI.
[Fuente: MCP de Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Codex descubre Skills personales en `~/.agents/skills` y admite directorios
enlazados. El enlace propuesto apunta a la Skill ya generada en la memoria;
no descarga ni crea una Skill nueva.
[Fuente: Skills de Codex](https://learn.chatgpt.com/docs/build-skills).

| Componente | Propuesta | Condición de aceptación |
| --- | --- | --- |
| Skill | `agent-toolkit`, enlace personal hacia la bóveda | Destino ausente o enlace físico ya idéntico; nunca reemplazar otro recurso |
| MCP | `agent-toolkit-memory`, STDIO local | Raíz de memoria exacta, sin sumar repositorios o bóvedas ajenos |
| Paquete | `@modelcontextprotocol/server-filesystem@2026.8.31` | Versión fijada en el adaptador revisado; disponibilidad e instalación todavía no comprobadas |
| Política | Las nueve herramientas de lectura del adaptador | Ninguna herramienta de escritura habilitada |
| Sesión | Proyecto fuente Agent Toolkit | No probar desde un contexto de AVISENS ni ampliar raíces para resolverlo |

Herramientas previstas: `read_text_file`, `read_media_file`,
`read_multiple_files`, `list_directory`, `list_directory_with_sizes`,
`directory_tree`, `search_files`, `get_file_info` y `list_allowed_directories`.

La lista limita este MCP, no las herramientas propias de shell/archivos del
cliente. No concede escritura automática ni certifica aislamiento del sistema.

## Puertas de ejecución

### C1 — Inspección local y plan, sin clientes

Requiere autorización para inspeccionar únicamente la configuración pertinente
de Codex y la entrada de Skill propuesta. No ejecutar `codex`, `npx`, `connect`
o `status`; no registrar servidores ni escribir configuraciones.

- Comprobar identidades físicas, permisos y posibles nombres homónimos.
- Examinar solo los campos relevantes; no publicar el archivo de configuración
  completo, valores sensibles, variables de otros servidores o credenciales.
- Preservar conexiones existentes, incluida la de AVISENS, sin consultarlas.
- Proponer el cambio exacto y comprobar que los bloques ajenos quedan intactos.
- Si hay enlaces inesperados, configuración ambigua o trabajo concurrente,
  detenerse y presentar el conflicto, sin repararlo silenciosamente.

Esta etapa no consulta cuentas, inventarios de modelos, cuotas ni facturación.

### C2 — Aplicación delimitada

Pendiente del plan C1 y de autorización explícita de sus efectos. `connect` en
vista previa ya ejecuta `codex mcp get`: no es una inspección puramente local.
La aplicación puede crear el enlace de Skill, registrar el servidor mediante
`codex mcp add` y editar `enabled_tools` en la configuración personal.

El arranque posterior del servidor usa `npx`; puede descargar paquetes y sus
dependencias desde npm. No se presenta como una instalación sin red o sin
efectos de startup. Ningún permiso para inferencias, autenticación o créditos se
deduce de aprobar la memoria. AD-3 conserva su estado de admisión pendiente.

Antes de aplicar, revalidar la base y revisar:

- El matcher actual acepta paquetes sin versión o con otra versión; no considerar
  esa coincidencia prueba de que el pin propuesto esté instalado.
- El editor de política usa patrones de texto; ante cabeceras diferentes o arrays
  multilínea no asumir preservación: revisar o detenerse, sin cambiar código aquí.
- El proceso de registro también puede reescribir configuración. Comprobar su
  diff local sin mostrar secretos; no prometer preservación antes de verificarla.
- La aplicación no es una transacción general: ante un resultado parcial,
  informar qué ocurrió y no restaurar ciegamente configuraciones compartidas.

### C3 — Comprobación real de lectura

Pendiente de una sesión autorizada en el proyecto correcto. Comprobar el catálogo
del servidor y su política efectiva; no basta el manifiesto o la salida de registro.

1. Invocar `list_allowed_directories` del servidor correcto. La raíz efectiva debe
   corresponder exclusivamente a la memoria acordada.
2. Leer `00-INICIO/Estado actual.md` mediante `read_text_file`; distinguir esta
   evidencia de la lectura directa realizada en R3.3.
3. Consultar propósito y límites usando la Skill; citar notas y no simular lecturas.
4. Si MCP roots cambia el alcance, aparece otro proyecto o falla la lectura,
   registrar el bloqueo. No ampliar directorios automáticamente ni ocultar el
   fallo usando lectura directa como prueba de MCP.

La consulta al modelo puede consumir cuota del plan; no se garantiza consumo
cero. No probar escrituras destructivas para comprobar la política.

## Criterios de aceptación de la conexión futura

| ID | Evidencia requerida | Estado |
| --- | --- | --- |
| CA-C01 | C1 autorizado, plan exacto y conflictos resueltos sin sobrescritura | Pendiente |
| CA-C02 | Skill apunta físicamente al destino aprobado y se descubre | Pendiente |
| CA-C03 | MCP configurado con el paquete fijado y las nueve herramientas | Pendiente |
| CA-C04 | Configuración ajena y las 19 entradas de memoria preservadas | Pendiente |
| CA-C05 | Directorios efectivos correctos y nota conocida leída por MCP | Pendiente |
| CA-C06 | Resultado parcial/bloqueado separado de una conexión validada | Pendiente |

## Exclusiones y siguiente aprobación

No activar Git de memoria, respaldo remoto, sincronización, automatizaciones,
Claude/Gemini, cambios en AVISENS, `.obsidian`, commits o push.
No modificar código funcional para corregir riesgos detectados en el adaptador.

La inspección local C1 se registra abajo. La siguiente aprobación solicitada
cubre la instalación deshabilitada propuesta, no la activación o consulta de IA.
La revisión de utilidad queda preparada para cierre, no aprobada por este documento.

## Inspección C1 y plan preparado — 2026-10-11

Se inspeccionaron en lectura la configuración personal pertinente, el destino
de la Skill y el manifiesto local. No se ejecutaron Codex, connect, status o npx;
no se leyeron almacenes de autenticación ni se mostraron valores de otros servidores.

- Configuración personal: archivo regular del usuario, modo `0600`, sin enlaces
  inesperados en sus padres; sintaxis TOML válida.
- No hay tabla `mcp_servers.agent-toolkit-memory` en la configuración examinada.
- El destino personal de la Skill `agent-toolkit` está ausente.
- No hay `.codex/config.toml` en la raíz fuente examinada; no se inspeccionaron
  políticas administradas, todas las capas heredadas o sesiones activas.
- No hay una selección distinta de CODEX_HOME en el entorno de esta inspección.
  Esto no acredita el entorno de otros procesos.
- Manifiesto y Skill de la bóveda son archivos regulares del usuario, modo `0600`.

Se construyó un candidato únicamente en memoria, sin guardarlo. Se comprobó
con un parser TOML que añade exclusivamente la tabla propuesta y conserva los
valores existentes. El candidato incluye `enabled = false`, el paquete fijado,
la bóveda acordada y las nueve herramientas de lectura. No prueba disponibilidad
del paquete, conexión, catálogo efectivo ni permisos de todas las capas.

### Ajuste propuesto: instalar antes de activar

Para evitar que el registro arranque el servidor en otras sesiones, se propone
una primera aplicación deshabilitada mediante edición local delimitada y el
enlace de Skill. No usar connect para esta fase: su registro nativo tiene efectos
distintos y el adaptador no ofrece una instalación deshabilitada separada.
La configuración directa está documentada en la fuente oficial de MCP citada.

La autorización de esta aplicación cubriría únicamente:

1. Revalidar huellas, propiedad, ausencia de conflictos y sintaxis inmediatamente
   antes de escribir; detenerse si algo cambió.
2. Crear el enlace personal de Skill hacia su directorio en la memoria acordada.
3. Añadir la tabla `agent-toolkit-memory` con `enabled = false`, conservando
   los bytes anteriores y los valores TOML ajenos; mantener modo `0600`.
4. Verificar configuración, enlace y preservación de la bóveda y el código,
   sin iniciar servidor, cliente, descarga o inferencia.

No se propone cambiar código para implementar este ajuste. Una Skill instalada
puede ser descubierta por sesiones del cliente, pero no acredita lectura MCP.
Activar el servidor, arrancar npx y realizar la consulta C3 siguen requiriendo
un alcance propio y la sesión correcta. Si la aplicación fuese parcial,
informar el estado real y no sobrescribir trabajo concurrente.

## Referencias locales

- [Adopción R3 y sus puertas](agent-toolkit-self-memory.md)
- [Contrato de conexión](../memoria/project-memory-connect.md)
- [Diagnóstico local](../memoria/project-memory-doctor.md)
- [Adaptador revisado](../../src/connect.js)
