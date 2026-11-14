# R3 — Memoria local del propio Agent Toolkit

## Estado

Propuesto el 2026-10-11 (America/Bogota). Profundidad SDD estándar, con puertas
explícitas para privacidad, escrituras y conexiones de clientes.

Proyecto piloto propuesto: Agent Toolkit. La selección y creación de su bóveda
requieren aprobación; preparar este documento no las activa. No hay permisos
de commit, push, cuentas, clientes de IA o configuración global en esta propuesta.

## Problema

R1 y R2 comprobaron la biblioteca, el recorrido ficticio y una instalación propia.
Falta demostrar una adopción local con contexto real y acotado: una memoria
separada del código, útil para continuar el trabajo y con estado verificable.

## Objetivo

Usar el Toolkit para organizar su propia memoria sin copiar una bóveda ajena.
El piloto distinguirá estructura creada, contenido revisado, integración de
lectura, sincronización y ejecución de agentes. Son estados distintos, no
consecuencias automáticas de crear una carpeta.

## Comportamiento actual comprobado

- Checkout local limpio en `e6593371a989bdc56441498f811a3ba9a678b814`.
- R2 fue publicada en privado y su candidato pasó 3.282/3.282 pruebas en
  macOS/arm64. Este diseño no repite ni renueva esa regresión.
- `init` puede crear estructura y Skill, pero no configura Git, remotos o MCP.
- `doctor` es local; con `syncMode:none` no exige un repositorio Git de memoria.
- `status` y `connect` pueden inspeccionar conexiones mediante clientes nativos;
  no se invocarán en las etapas locales de este piloto.
- AD-3 permanece sin admisión en la documentación vigente. Crear una memoria
  no aporta la evidencia que falta ni autoriza un arranque de IA.

## Vinculación propuesta

| Elemento | Valor o condición |
| --- | --- |
| Proyecto | Agent Toolkit |
| Identificador | `agent-toolkit` |
| Fuente | Checkout físico revisado de `Agent-Toolkit` |
| Rama principal e integración | `main`, sin inventar `develop` |
| Memoria | Directorio nuevo `AGENT-TOOLKIT-MEMORY`, fuera del código |
| Perfil | `canonical-v1` |
| MCP declarado | `agent-toolkit-memory`, todavía no instalado |
| Sincronización inicial | `none`; sin Git ni remoto de memoria |
| Automatización | Deshabilitada |

Las rutas absolutas locales y el destino autorizado se acuerdan en la entrega
privada al usuario, no se versionan en esta biblioteca. No se consultó la
configuración de clientes para afirmar que el nombre MCP esté libre.

## Fuera de alcance

- Cambiar código funcional, dependencias o contratos para realizar la adopción.
- Leer o modificar AVISENS u otras memorias, o copiar sus notas y Skills.
- Crear repositorios Git, remotos, commits, tags, releases o pushes.
- Registrar la bóveda en la configuración de Obsidian o tocar `.obsidian`.
- Instalar enlaces de Skills o cambiar configuraciones globales de clientes.
- Ejecutar `status`, `connect`, clientes de IA, consultas de cuentas o inferencias.
- Activar créditos, sincronización automática o un supervisor de carpetas.
- Convertir las plantillas tutor/autónomo en ejecución automática.

## Requisitos

### Funcionales

- Usar la vista previa de `init` antes de crear; revalidar fuente, destino y
  rutas generadas inmediatamente antes de una aplicación autorizada.
- Crear únicamente los 19 archivos propuestos por la plantilla. Una diferencia
  respecto al plan revisado exige detenerse y revisar, no ampliar el alcance.
- Comprobar la repetición idéntica antes de personalizar las notas: debe informar
  `unchanged` y conservar bytes y tiempos de modificación.
- Preparar cuatro notas iniciales usando únicamente documentación y código del
  Toolkit revisados. El resto permanece claramente como plantilla.
- Ejecutar `doctor --strict` antes y después de personalizar. Un resultado
  favorable valida estructura y controles locales, no calidad completa del contexto.
- Conservar estado explícito: bóveda local creada, Skill generada pero no instalada,
  MCP no conectado, memoria sin Git y sincronización deshabilitada.

### No funcionales

- Fuente y memoria físicamente separadas; sin enlaces o rutas inesperadas.
- Propietario local comprobado. Fijar permisos de la raíz nueva a `0700` y de
  los archivos nuevos enumerados a `0600`, sin alterar padres, umask o políticas
  globales. No prometer cifrado o privacidad universal por esos permisos.
- Preservar los bytes, dependencias y estado de Git del checkout fuente durante
  la creación. El borrador propio de R3 puede estar sin versionar: debe quedar
  identificado y conservado, no tratarse como una entrega publicada.
- No registrar credenciales, cuentas, inventarios de modelos o encargos privados.
- Guardar fuentes y fechas solo con el alcance efectivamente revisado.

## Notas iniciales autorizables

1. `00-INICIO/Estado actual.md`: R1/R2, estado de la bóveda y límites de conexiones.
2. `01-PRODUCTO/Producto.md`: propósito, usuarios y capacidades actuales del Toolkit.
3. `02-ARQUITECTURA/Arquitectura.md`: separación código/memoria, CLI local y
   coordinación manual; no afirmar admisión de clientes reales.
4. `05-ENTREGAS/Entregas.md`: hitos cerrados, evidencia fechada y próximos pasos,
   sin convertir un porcentaje orientativo en resultado comprobado.

Fuentes previstas: README, arquitectura del sistema, cierres de R1/R2, guía del
equipo y contratos de la CLI. No leer toda la biblioteca o todas las memorias por
defecto. El registro de sincronización no inventará PRs: R1/R2 tienen evidencia
de commits y publicación, no PRs ficticios que registrar como fusionados.

## Etapas y puertas

### R3.1 — Descubrimiento y vista previa

Ejecutado en modo de lectura: fuente revisada, comprobación puntual de ausencia
del destino propuesto y `init` sin `--apply`.

Resultado: `status:preview`, `create:19`, `unchanged:0`, `conflicts:0`, exit 0.
Se comprobó después que el destino seguía ausente y el checkout limpio.
No se creó memoria ni se consultaron clientes de IA o otras bóvedas.

### R3.2 — Crear y preparar contenido local

Pendiente de aprobación de esta especificación y del destino exacto.

1. Comprobar de nuevo base, destino, propietario y plan; detenerse ante cambios
   ajenos, rutas inseguras o conflictos.
2. Aplicar `init` sobre el destino aprobado y comprobar el listado exacto de
   archivos y directorios creados; fijar permisos solo dentro de ese destino nuevo.
3. Repetir con la misma entrada antes de personalizar; ejecutar `doctor --strict`.
4. Revisar y editar únicamente las cuatro notas enumeradas, con fuentes estables.
5. Repetir `doctor --strict`, validar enlaces, formato, posibles secretos y
   preservación del código fuente. Registrar evidencia sin salidas extensas.

La fecha de generación forma parte de las entradas. Si un cambio de día altera
el contenido esperado, revisar el plan; no forzar una falsa idempotencia.
Después de personalizar, no repetir `init --apply` como mecanismo de mantenimiento:
las notas distintas deben producir conflicto y conservarse.

### R3.3 — Revisar adopción y preparar la conexión siguiente

Revisar si las notas responden, con fuentes, qué hace el producto, qué está
implementado, qué sigue manual y qué falta comprobar. Preparar una propuesta
para un primer cliente de lectura, sin ejecutarlo o instalar configuraciones.

Una conexión futura requiere autorización propia, comprobación de nombres/rutas,
política de herramientas y lectura real de una nota conocida. Las entradas
declaradas en el manifiesto no acreditan conexión. Ese cierre tampoco certifica
disponibilidad de modelos, suscripción, consumo o AD-3.

## Criterios de aceptación

| ID | Resultado observable |
| --- | --- |
| CA-R301 | Vista previa sin escrituras; fuente y destino separados y plan revisado de 19 archivos |
| CA-R302 | Aplicación autorizada crea solo el listado aprobado; ningún componente global instalado |
| CA-R303 | Repetición previa a personalización conserva bytes y tiempos; un conflicto no sobrescribe contenido |
| CA-R304 | Las cuatro notas contienen contexto real contrastado; notas no revisadas permanecen como plantillas |
| CA-R305 | Doctor estricto termina sin errores ni advertencias, antes y después del contenido inicial |
| CA-R306 | Fuente, dependencias y estado Git conservados; permisos limitados al destino nuevo |
| CA-R307 | Skill generada, MCP desconectado, Git/automatización ausentes y clientes sin admisión se presentan por separado |
| CA-R308 | Ninguna otra memoria, secreto, cuenta, cliente de IA o configuración global consultada o modificada |

## Errores, recuperación y límites

- Destino que aparece o cambia entre revisión y aplicación: detenerse y conservarlo.
- Creación parcial: registrar archivos realmente creados y dejar el trabajo
  pendiente. No borrar una bóveda persistente como si fuera un fixture temporal.
- Doctor con advertencias: diagnosticarlas; no quitar `--strict` para afirmar éxito.
- Fecha de plantilla: no significa que todo el contenido esté verificado. Las
  notas siguen en `estado:plantilla` hasta revisarlas de forma completa.
- Skill generada: no significa instalada o cargada por una sesión.
- Nombre MCP homónimo: revisar el conflicto antes de una futura conexión;
  no reemplazar un servidor existente ni ampliar sus raíces silenciosamente.
- Acceso de una IA a otra memoria: bloquear y revisar alcance, no considerarlo
  una ventaja de compartir el sistema.

## Alternativas consideradas

- Otro proyecto real: útil como piloto posterior, pero requiere elegirlo y
  revisar su contexto y autorización. No se asume ahora cuál sería.
- AVISENS: ya tiene memoria y automatización propias; no demuestra una adopción
  nueva ni justifica tocar su configuración para completar R3.
- Solo más fixtures: continúan siendo útiles para regresiones, pero no prueban
  calidad del contexto real ni mantenimiento de una memoria adoptada.

## Plan de tareas

- [x] R3.1: inspección acotada, vista previa y conservación comprobadas.
- [ ] R3.2: destino y creación aprobados, cuatro notas revisadas y doctor estricto.
- [ ] R3.3: cierre local y propuesta de conexión, con límites y evidencia explícitos.

La primera aprobación solicitada cubre R3.2, no una conexión real ni su publicación.
El cierre documental de la biblioteca y cualquier commit también se revisarán
por separado; no se incluyen implícitamente por completar el piloto.

## Evidencia de cierre

Solo R3.1 comprobado. No existe todavía la bóveda del piloto. R3.2/R3.3 siguen
pendientes y no se presentan como resultados del preview o de las pruebas de R2.

## Relacionado

- [Sistema de memorias](../memoria/project-memory-system.md)
- [Inicialización](../memoria/project-memory-init.md)
- [Diagnóstico local](../memoria/project-memory-doctor.md)
- [Estado y sus límites](../memoria/project-memory-status.md)
- [Beta R1](agent-toolkit-private-beta.md)
- [Validación R2](agent-toolkit-clean-install.md)
- [Guía del equipo manual](../../templates/agent-team/README.md)
