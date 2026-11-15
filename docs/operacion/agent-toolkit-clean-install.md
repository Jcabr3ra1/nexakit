# R2 — Validación desde una copia nueva

## Estado

Propuesto, verificado técnicamente y con cierre documental aprobado el
2026-10-11 (America/Bogota), después de completar la beta privada R1.
Commit local de las tres rutas revisadas autorizado; push no autorizado.
Profundidad SDD: estándar para la prueba local; revisión rigurosa de los límites
de instalación, red, conservación de datos y limpieza.

El usuario autorizó la copia temporal, instalación acotada y pruebas, sin
llamadas de IA, commit ni push. Tras encontrar un fallo reproducible, autorizó
corregir únicamente la prueba de permisos y repetir la suite, sin tocar código
funcional. «Sigamos» dio paso a este cierre documental, no a publicar o crear
commits. Después, el usuario aprobó el cierre y autorizó el commit local de sus
tres rutas, sin push. Estas autorizaciones no se convierten en permisos para
futuros lotes, clientes, cuentas o inferencias.

## Problema

R1 comprobó herramientas y un recorrido ficticio con dependencias existentes.
No demuestra que una copia nueva pueda instalar únicamente sus dependencias
declaradas y ejecutar el mismo recorrido sin depender del checkout del autor.

## Objetivo

Comprobar la primera experiencia de uso desde una copia física nueva del contenido
versionado, con dependencias propias y datos ficticios, conservando evidencia
de la revisión exacta, instalación y comprobaciones realmente ejecutadas.

## Comportamiento comprobado al proponer R2

- Base local inspeccionada: `a43e5b797928e29d9ae8821282cb5f5319545436`, rama `main`,
  árbol limpio. `origin/main` coincide como referencia local; no se consultó
  GitHub durante esta preparación.
- El paquete declara versión `0.1.0`, Node.js `>=20`, módulos ESM y Ajv como
  dependencia. Existe `package-lock.json`.
- R1 tiene tres entregas cerradas. La regresión documentada de 3.280 pruebas
  pertenece al 2026-10-09; no se repitió para preparar esta propuesta.
- La coordinación de los agentes sigue siendo manual. AD-3, disponibilidad de
  modelos y admisión de clientes reales no se resuelven con esta validación.

El estado limpio describe la base anterior a esta especificación, no el árbol
con la corrección y el cierre pendientes de commit. El candidato final fue esa
revisión más el cambio autorizado en `test/client-auth-diagnostic.test.js`.

## Fuera de alcance

- API keys, créditos, inferencia, autenticación o configuración de clientes de IA.
- Instalaciones globales, actualizaciones de Node/npm o cambios de shell.
- Proyectos reales, bóvedas de Obsidian y encargos privados.
- Cambios en código funcional, contratos, versiones o dependencias para hacer
  pasar la prueba. Un fallo requerirá diagnóstico y una propuesta separada.
- Clonación de GitHub, push, tags, releases, npm publish y cambio de privacidad.
- Certificar todas las versiones de Node, Linux o Windows.

La corrección de la prueba se aprobó por separado tras el diagnóstico. No
modificó la lógica del colector, relajó sus controles ni omitió casos de prueba.

## Diseño aplicado y límites de repetición

### R2.1 — Preparar el candidato local

Crear, bajo autorización nueva, un directorio temporal propio y físico. Extraer
solo el contenido versionado de una revisión fijada y comprobada de Git; no
copiar `.git`, `node_modules`, archivos ignorados, configuración personal ni
autenticación. Revisar antes el listado de extracción y rechazar destinos que
escapen de la raíz o enlaces inesperados.

Comparar los bytes y rutas extraídos con el contenido Git esperado. Registrar
por separado Node/npm observados y alcance de plataforma. No invocar clientes
de IA ni consultar archivos de credenciales para obtener esas observaciones.

En el candidato final se aplicó después únicamente el diff autorizado del test
y se comprobó su coincidencia exacta con el archivo corregido del checkout.
El documento de R2, todavía sin versionar, no se añadió al candidato ejecutable.

El resultado es una copia del contenido versionado, no una clonación remota ni
una prueba de instalación del sistema operativo. La herramienta `status` puede
informar que esa copia carece de checkout Git; no se confundirá con un fallo del
paquete ni se fabricará un upstream real.

### R2.2 — Instalar y comprobar

Tras aprobar el alcance de red, instalar desde la lockfile en la copia nueva.
No enlazar ni copiar los `node_modules` existentes. Deshabilitar scripts de
instalación, auditoría, financiación y configuración personal de npm mediante
opciones y configuración propias revisadas, sin modificar las del usuario.

La instalación necesita un permiso específico para consultar el registro de
paquetes y descargar las dependencias fijadas. No comparte contexto de proyectos
con proveedores de IA ni autoriza otros destinos. Si las condiciones no pueden
acotarse, detenerse; no cambiar permisos o usar credenciales como alternativa.

Después de instalar:

1. Ejecutar las ayudas de `project-memory` y de `nexakit`.
2. Ejecutar la prueba integrada de R1.2 con sus fixtures ficticios.
3. Ejecutar la regresión completa con concurrencia 1 y conservar sus resultados.

Nota histórica: en la versión original de este procedimiento también se
ejecutaban las ayudas de `agent-task` y `agent-task verify` y el ejemplo de
`agent-task prepare`. Ese binario se retiró en la 0.11.0 (lo sustituye la
fábrica), así que esos pasos ya no aplican.

Las comprobaciones usarán las dependencias de esa copia. La ejecución de pruebas
puede crear fixtures y procesos Git locales propios; no se presenta como una
función sin efectos ni como aislamiento del sistema operativo.

### R2.3 — Revisar y documentar

Comparar el árbol original y los archivos del candidato antes y después.
Registrar resultados, fallos, omitidas y diferencias sin secretos ni salidas
extensas. Solo tras satisfacer los criterios se propone el cierre documental
y cualquier commit; no se publican automáticamente.

Retirar únicamente recursos temporales propios cuya ruta e identidad coincidan
con las registradas. Si su identidad cambió o aparecen datos ajenos, detener
la limpieza y conservarlos para revisión; nunca borrar una raíz amplia.

## Criterios de aceptación

| ID | Evidencia exigida |
| --- | --- |
| CA-R201 | Revisión fijada, rutas físicas y bytes de la copia coinciden; checkout original intacto |
| CA-R202 | Dependencias instaladas desde la lockfile, sin enlaces al checkout original ni instalación global |
| CA-R203 | Ayudas terminan con exit 0 usando las dependencias de la copia |
| CA-R204 | Ejemplo produce `prepared-draft`; ejecución, envío, escritura y admisión false; modelo ficticio y observado desconocido |
| CA-R205 | Prueba integrada termina sin fallos, canceladas u omitidas; el carácter simulado de GitHub/MCP permanece explícito |
| CA-R206 | Regresión completa de los bytes finales termina satisfactoriamente; recuento real, versión, plataforma y fecha registrados |
| CA-R207 | Ninguna consulta a clientes de IA, proyectos reales, memorias o credenciales; no se reinterpreta la prueba como AD-3 |
| CA-R208 | Preservación del original y limpieza limitada comprobadas; ninguna publicación o commit implícito |

## Errores y límites

- Lockfile incompatible: informar, no regenerarla silenciosamente.
- Dependencia que exija scripts: mantener el bloqueo y revisar esa necesidad.
- Registro inaccesible: resultado no comprobado, no prueba aprobada.
- Base o destino cambiados: invalidar el candidato antes de continuar.
- Prueba fallida u omitida: registrar el hecho; no reducir la suite para aprobar.
- Caché npm: puede evitar descargas, pero debe declararse; una instalación propia
  no equivale a una máquina sin caché ni a una prueba de red completa.
- Efectos no previstos: detenerse, registrar lo observado y no ampliar permisos.

## Alternativas

- Reutilizar dependencias existentes: rápido, pero no prueba instalación propia.
- Clonar de GitHub: útil para validar distribución remota después; añade una
  autorización de red/autenticación Git que no necesita este primer recorrido.
- Probar en todas las plataformas: amplía cobertura, pero requiere entornos y
  criterios propios. Esta entrega conserva el alcance macOS realmente observado.

## Plan de tareas

- [x] R2.1: límites aprobados, candidato propio y bytes/entorno verificados.
- [x] R2.2: instalación acotada, ayudas, ejemplo y pruebas ejecutados.
- [x] R2.3: evidencia revisada, cierre documental aprobado y preservación comprobada.

Rutas del lote para revisión: este documento, `primeros-pasos.md` y la prueba
corregida `test/client-auth-diagnostic.test.js`. El README conserva su evidencia
histórica de R1, sin renovar aquella ejecución. Código funcional, dependencias
y configuración permanecen intactos. El commit local tiene autorización humana
separada de la revisión técnica; publicar no está autorizado.

## Evidencia de cierre

### Candidato y entorno

- Base Git: `a43e5b797928e29d9ae8821282cb5f5319545436`, más solo la corrección del test.
- Archivo corregido probado: `test/client-auth-diagnostic.test.js`.
- SHA-256 del test final:
  `6b3642b27822d48b90b4821b9382f8de7ce245e509df37e6ebde6b9a8ca4273a`.
- Archivo Git extraído: 238 rutas, sin `.git`, archivos ignorados o dependencias
  del checkout. SHA-256 del tar de la base:
  `79b8f5b0f82521cd19e991ad25f883cb237f955f6fd3807bdd66af6899503e47`.
- Entorno observado: macOS/arm64, Node.js `v24.14.1`, npm `11.11.0`.
- Los fixtures C usaron Clang y el SDK macOS ya existentes; no se instalaron
  herramientas del sistema. Eso es un requisito de esas pruebas, no de las
  ayudas o de preparar un encargo ficticio.
- Copia, caché npm y configuración npm propias. Se instalaron cinco paquetes
  desde la lockfile, con scripts de instalación, auditoría, financiación y
  notificador de actualización deshabilitados. Las URLs fijadas usaban
  `https://registry.npmjs.org`; no se usaron claves o configuración personal npm.
- El `HOME` original se conservó, sin redirigirlo ni copiar autenticación. Solo
  se incluyeron las variables necesarias del entorno controlado, no API keys.

### Correspondencia de criterios y resultados

| Criterio | Evidencia ejecutada el 2026-10-11 |
| --- | --- |
| CA-R201 | Rutas de archivo verificadas, extracción física y bytes contrastados; candidato final coincide con la base más el test autorizado |
| CA-R202 | `npm ci` terminó con exit 0; cinco paquetes propios, versiones de lockfile comprobadas y Ajv resuelto dentro del candidato, sin enlaces al checkout |
| CA-R203 | Las tres ayudas de primeros pasos terminaron con exit 0 |
| CA-R204 | Ejemplo: `prepared-draft`, modo `tutor`, modelo ficticio `example-alpha-r2`, esfuerzo `brief`; ejecución/envío/escritura/admisión false, disponibilidad false, modelo observado unknown y lista vacía |
| CA-R205 | Prueba integrada ficticia: 1/1, exit 0; duración 3498.613542 ms, sin fallos, canceladas, omitidas o todo; GitHub/MCP siguen simulados |
| CA-R206 | Suite completa: 3.282/3.282, exit 0, concurrencia 1; duración 191778.816709 ms, sin fallos, canceladas, omitidas o todo |
| CA-R207 | No se ejecutaron clientes reales de IA ni se consultaron cuentas, credenciales, proyectos reales o memorias; los clientes ejecutados por las pruebas son fixtures sintéticos |
| CA-R208 | Bytes finales del candidato y 239 rutas del checkout comprobados; solo el test difiere de la base anterior a la corrección; dependencias originales intactas, temporales retirados por identidad, sin staging/commit/push |

Las tres pruebas enfocadas de permisos pasaron 3/3 en 278.780708 ms, sin omisiones.
Las duraciones son observaciones, no compromisos de rendimiento. Las cifras de
R1 conservan su fecha y alcance; no se suman a las de R2.

### Intentos anteriores y corrección autorizada

Antes del candidato final hubo problemas que no se presentan como aprobados:

1. El lector del arnés esperaba TAP, pero Node emitió otro formato; se fijó
   explícitamente `--test-reporter=tap` para obtener recuentos comprobables.
2. Una corrida completa tuvo 3.172 aprobadas y 108 fallidas porque el arnés
   omitió `HOME`, requerido por los diagnósticos sintéticos. Se corrigió el
   entorno conservando su valor original, sin modificar la biblioteca.
3. Dos corridas con ese entorno corregido tuvieron 3.279 aprobadas y una fallida:
   `AD pin/parent special-mode rejected before spawn`. La prueba suponía que
   `chmod(2500)` conservaba `setgid`; en el directorio temporal el grupo del
   archivo no pertenecía al usuario y macOS dejaba el modo efectivo en `0500`.
   El escenario inseguro no se había construido realmente.
4. El usuario autorizó corregir ese test. Ahora modela metadatos con `setgid`,
   `setuid` y `sticky`, manteniendo los demás campos del pin reales y coincidentes.
   Comprueba bloqueo antes de abrir el artefacto o intentar iniciar un proceso.
   No cambió permisos reales para forzar un aprobado ni redujo la suite.
5. Una nueva copia, instalación propia y suite completa con los bytes finales
   produjeron los resultados verdes registrados arriba. Los dos casos añadidos
   explican el cambio de 3.280 a 3.282 pruebas.

### Preservación y revisión de calidad

En la validación final las otras 238 rutas del checkout conservaron sus bytes;
las dependencias originales conservaron las huellas y metadatos registrados.
El archivo corregido conservó la huella probada después de las pruebas;
el candidato no cambió archivos de producción. El índice permaneció vacío y
HEAD siguió en la base declarada.

La limpieza retiró únicamente copias, fixtures, cachés y arneses temporales
propios con identidad verificada. Son reproducibles desde la base y la lockfile;
no se retiraron dependencias originales ni datos del usuario.

Quality-gate: **Aprobado con observaciones de alcance** para la corrección del
test y la validación local de R2. Esta fase documental solo registra y contrasta
esa evidencia; no repite ni renueva las pruebas por editar Markdown.

Esto no acredita una clonación remota, máquina sin herramientas previas, Linux,
Windows, todas las versiones de Node, aislamiento del sistema operativo,
ausencia universal de efectos o admisión AD-3. La prueba de permisos modela
metadatos para comprobar la lógica del guard, no demuestra que el sistema
operativo preserve físicamente bits especiales.

## Puerta siguiente

Consolidar el cierre aprobado en un commit local de las tres rutas del lote y
comprobar sus bytes e índice final. La publicación posterior y cualquier adopción
real o cliente nativo requieren su propio alcance y autorización. Ningún
porcentaje orientativo global sustituye los criterios y la evidencia de este hito.

## Relacionado

- [Beta privada R1](agent-toolkit-private-beta.md)
- [Primeros pasos](../guias/primeros-pasos.md)
- [Guía técnica](../guias/uso.md)
- [Prueba integrada ficticia](../../test/private-beta-integration.test.js)
