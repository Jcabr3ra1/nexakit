# RG-2 — Plan de conexión privada del piloto

## Estado

RG-2 autorizado el 2026-10-12 (America/Bogota). Migración, prueba independiente
y activación propia aplicadas. Lectura nativa comprobada en la app y reportada
por el usuario desde un chat de Agent Toolkit; validación de cambios de roots
en una misma sesión nativa todavía pendiente. CA-RG12 no se cierra por esa lectura.
No se lanzó otra IA ni se reinició el host automáticamente. La autorización
posterior cubre solo este documento y Estado actual de la memoria, sin commit
ni push; no concede permisos de código, cuentas o configuración.

## Base revisada antes de la aplicación

- RG-1: 3.364/3.364 pruebas históricas de la entrega revisada y 82 casos nuevos.
  Las huellas de sus 12 archivos se volvieron a comprobar: sin cambios.
- La base Git sigue en e659337; los módulos de RG-1 están locales y sin commit.
  Ese HEAD no debe presentarse como si contuviera el intermediario.
- La entrada personal del piloto era filesystem directo por npx,
  versión 2026.8.31, con nueve herramientas y enabled:false.
- El manifiesto real del piloto fue aceptado por loadMemoryPolicy sin iniciar
  backend. Esto no prueba lectura por el host.
- El candidato de configuración se creó únicamente en memoria. Su TOML es
  válido y la comparación estructural cambia exclusivamente la tabla del piloto.
- El MCP protegido todavía no estaba disponible en el catálogo de la sesión.

No se repitió la suite completa, consultaron cuentas o ejecutaron clientes nativos
durante esta preparación. Las observaciones de licencia/deprecación de RG-1
siguen abiertas: no se convierten en una aprobación de distribución.

## Cambio delimitado

Solo la tabla mcp_servers.agent-toolkit-memory en la configuración personal.
Las rutas reales y las huellas de configuración se conservan en el plan privado
de la sesión, no en este documento reusable.

```toml
[mcp_servers.agent-toolkit-memory]
command = "<node-absoluto-verificado>"
args = ["<toolkit>/bin/project-memory-mcp.js", "--manifest", "<boveda>/project-memory.json"]
cwd = "<toolkit>"
enabled_tools = ["read_text_file", "read_media_file", "read_multiple_files", "list_directory", "list_directory_with_sizes", "directory_tree", "search_files", "get_file_info", "list_allowed_directories"]
enabled = false
```

Los marcadores no son comandos ejecutables. Sustituir la invocación legacy por
Node con manifiesto explícito; no mantener npx como fallback. Conservar la Skill
instalada, los nueve nombres y todos los bloques ajenos, incluida AVISENS.
El cwd hace explícito el proceso del piloto; no reemplaza la comprobación de raíz
ni cambia por sí solo el proyecto asociado al chat del host.

Codex admite command, args, cwd y enabled_tools para STDIO; la configuración es
compartida por sus superficies locales del mismo host. No asumir que el efecto
queda limitado a un único chat.
[Fuente: documentación oficial de MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Aplicación autorizable de RG-2

Una autorización expresa de este plan cubriría la secuencia completa del piloto,
no preguntas nuevas por cada campo o archivo:

1. Revalidar las huellas de RG-1, bin, manifiesto, Node y configuración; detenerse
   ante un cambio en la entrada del piloto o un conflicto, sin sobrescribirlo.
2. Migrar únicamente la tabla propia y mantener enabled:false. Comprobar sintaxis,
   modo 0600, bytes ajenos preservados y valores TOML sin diferencias fuera de
   esa tabla. No usar codex mcp add, connect o status para realizar la migración.
3. Verificar el comando exacto mediante una prueba MCP independiente acotada
   de lectura real, con roots ajenas y notificación tardía: solo catálogo,
   directorios y notas conocidas; sin escrituras. Esa prueba no certifica Codex.
4. Si los controles pasan, activar solo el piloto con enabled:true y verificar
   que esa sea la única diferencia respecto al candidato ya revisado.
5. Recargar MCP en una sesión humana del host asociada a Agent Toolkit y realizar
   la validación nativa descrita abajo. No lanzar otra IA o crear un chat nuevo
   automáticamente; si la sesión aún no existe, coordinar ese paso con el usuario.

La dependencia ya está instalada: el proceso no utiliza npx ni una descarga
de paquetes en runtime. Un entorno nuevo requiere instalación y verificación
previas, no una descarga improvisada durante la conexión.

Activar o consultar MCP no incluye permisos de programación, autenticación,
créditos extra, configuración de modelos o admisión AD-3. La consulta del usuario
al modelo puede consumir cuota de su plan; no prometer consumo cero.

## Validación del host real

- Confirmar el host, su proyecto, la entrada cargada y que no siga usando el
  filesystem directo. Una captura de ajustes no sustituye llamadas de herramientas.
- tools/list expone exactamente las nueve herramientas; ninguna escritura aparece.
- list_allowed_directories del piloto devuelve exclusivamente la bóveda acordada.
- Listar 00-INICIO antes de leer Estado actual y consultar Producto por MCP.
  Comparar una nota conocida con la huella obtenida en el plan privado.
- Cambiar/notificar roots en la misma sesión cuando el host lo permita y volver
  a consultar el alcance. Si no puede hacerse, declarar esa parte sin evidencia,
  aunque RG-1 la haya comprobado con un cliente sintético.
- Conservar notas, manifiesto y código. No invocar escritores para probar su
  rechazo sobre datos reales; ese negativo ya se ejecutó sobre fixtures.

Solicitud mínima para la sesión humana, una vez el piloto esté activo:

```text
Usa la Skill agent-toolkit y el MCP agent-toolkit-memory. Comprueba primero
list_allowed_directories, lista 00-INICIO y lee Estado actual y Producto.
Dime el propósito de la herramienta y qué sigue manual. Cita las notas y señala
contradicciones con el estado comprobado. No edites archivos ni configures nada.
```

Las notas de infraestructura inicialmente conservaban el estado de R3.2. Estado
actual se reconcilia con autorización separada después de la lectura nativa;
otras notas pueden conservar ese estado histórico. La respuesta debe señalar
contradicciones y contrastar fuentes, no fingir una consulta ni editar notas
adicionales. Actualizarlas requiere autorización propia sobre rutas enumeradas.

## Parada y recuperación

- Protocolo no admitido, catálogo distinto, raíz inesperada, nota diferente o fallo
  de conexión: no cerrar RG-2 como aprobado y no volver al servidor directo.
- Si ya se activó y la entrada todavía coincide con el candidato propio,
  deshabilitar únicamente ese piloto después de revalidarlo. Esa desactivación
  preventiva forma parte de la aplicación autorizable, no un rollback de la
  configuración compartida completa.
- Si otro proceso cambió la tabla, conservarla y pedir intervención; no restaurar
  bytes antiguos, eliminar servidores o cambiar paquetes/modelos automáticamente.
- Error del host o evidencia faltante no prueba disponibilidad, consumo, cuenta,
  versión observada de un modelo o calidad de todas las notas.

## Criterios y estado

| ID | Evidencia requerida | Estado |
| --- | --- | --- |
| RG2-01 | RG-1 y manifiesto revisados; candidato propio válido, sin cambios ajenos | Preparación local comprobada |
| RG2-02 | Migración deshabilitada y preservación de configuración verificadas | Comprobada; aplicada con autorización |
| RG2-03 | Comando protegido lee notas reales y mantiene raíz frente a roots ajenas | Comprobado con cliente independiente |
| RG2-04 | Activación propia verificada y recarga en el host correcto | Activación comprobada; carga efectiva en la app comprobada, chat de Agent Toolkit reportado por el usuario; mecanismo de recarga no observado |
| RG2-05 | Lectura nativa, catálogo y raíz efectivos; cambios de roots con evidencia cuando disponibles | Lectura, catálogo y raíz comprobados en la app; falta cambio de roots en la misma sesión nativa; CA-RG12 no cerrado |
| RG2-06 | Estado parcial, observaciones y parada explícitos, sin cambios de código/memoria durante la conexión | Estado parcial informado; actualización posterior limitada a este documento y Estado actual, con autorización propia |

## Evidencia de aplicación — 2026-10-12

- Se revalidaron las huellas de RG-1, manifiesto, Node y configuración antes de
  aplicar. No hubo cambios o conflictos frente al candidato aprobado.
- Se sustituyó solo la tabla propia, manteniéndola deshabilitada durante la prueba.
  Hash esperado y obtenido del candidato coincidentes; TOML válido y modo 0600.
  El resto de los bytes de configuración se conservó.
- Se ejecutó exactamente command/args/cwd del candidato usando un cliente SDK
  independiente, no un CLI de IA. Su catálogo contenía exactamente nueve lecturas.
  Se listó 00-INICIO y se leyeron Estado actual y Producto; las dos huellas
  coincidieron con las notas reales fijadas antes de probar.
- El cliente declaró una raíz fuente ajena a la bóveda y envió después un aviso
  de roots cambiadas. El alcance permaneció idéntico; cero solicitudes roots
  al cliente y una segunda lectura con la misma huella. No se invocaron escritores.
- El proceso de prueba cerró, con stderr vacío. No hubo descargas, consultas de
  cuentas o inferencias; esta evidencia no se presenta como validación de Codex.
- Después de pasar, se cambió exclusivamente enabled:false a enabled:true en la
  tabla propia. El hash de configuración coincidió con el candidato de activación
  y la comparación TOML confirmó comando, argumentos, cwd y nueve herramientas.
- Las 19 entradas de memoria y los 250 archivos fuente previos permanecieron
  intactos al verificar la activación. Solo se añadió después este cierre documental.
  No se ejecutaron staging, commit, push o cambios en otras conexiones.

Resultado de la aplicación inicial: **Aprobado con observaciones para
migración/activación local**. En ese momento no había evidencia suficiente para
RG2-05: faltaba el catálogo nativo y las notas no se habían actualizado.

## Evidencia nativa y reconciliación documental — 2026-10-12

- Después de la intervención humana en la app, el catálogo de esta conversación
  expuso exactamente las nueve herramientas protegidas de lectura. Las llamadas
  reales a list_allowed_directories, list_directory y read_text_file funcionaron.
  El único directorio permitido fue la memoria propia de Agent Toolkit.
- Se listaron 00-INICIO y 01-PRODUCTO antes de leer Estado actual y Producto.
  Ambas huellas SHA-256 coincidieron con las fijadas antes de la prueba. También
  se leyó Mantenimiento de la memoria. No se invocaron escritores.
- Esta comprobación directa ocurrió en una conversación cuyo proyecto seguía
  siendo AVISENS, no en un chat asociado a Agent Toolkit. El cwd del servidor
  no cambia el proyecto del chat ni autoriza acceso a otras memorias.
- El usuario aportó después la respuesta de un chat separado: confirmó el cwd
  de Agent Toolkit, la raíz exclusiva y la lectura de las mismas dos notas.
  Se registra como lectura reportada por el usuario; no como revisión directa
  del historial, hashes o todas las llamadas de esa otra sesión.
- No se observó el botón o mecanismo exacto de recarga. La disponibilidad y
  lectura efectiva sí se comprobaron; no se afirma una operación de UI distinta.
- No se cambió ni notificó roots dentro de una misma sesión nativa. Ese control
  continúa pendiente; la invariancia del cliente independiente no lo sustituye.
- Se autorizó actualizar solamente este documento y Estado actual de la memoria.
  La Skill instalada se comprobó mediante su enlace a la memoria propia. No se
  repitió la suite, modificó código/configuración ni ejecutó staging, commit o push.
- Las cifras históricas de 3.280 y 3.282 no son resultados contradictorios: R2
  documenta dos casos añadidos en agent-toolkit-clean-install.md. Las 3.364 de
  RG-1 pertenecen a otra entrega local; ninguna cifra implica una nueva ejecución.

Resultado actualizado: **Aprobado con observaciones para consulta local de
lectura**; **sin evidencia suficiente para el cierre completo de RG2-05 y
CA-RG12**. Siguen pendientes las roots nativas y las observaciones de RG-1.

## Exclusiones

No implementar RG-3 o cambiar connect/status, código de RG-1, paquetes, schemas,
Skills, otras conexiones, AVISENS, Obsidian, memorias, Git o publicaciones.
La autorización solicitada es para este piloto privado, no una integración
multiagente automática ni una distribución de dependencias.

## Relacionado

- [Especificación y cierre RG-1](project-memory-mcp-guard.md)
- [Propuesta original de conexión](../operacion/agent-toolkit-codex-memory.md)
- [Adopción local R3](../operacion/agent-toolkit-self-memory.md)
- [Contrato de conexión existente](project-memory-connect.md)
