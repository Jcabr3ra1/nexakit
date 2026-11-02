# Elegir el flujo de cierre

Usa siempre la bóveda y las ramas obtenidas de su manifiesto. Los ejemplos usan
`<bóveda>`, `<N>` y `<toolkit>` como argumentos que debes sustituir y entrecomillar.

## Código local o PR abierto

Revisa el cambio y ejecuta las comprobaciones proporcionales. Informa los bloqueos
reales. Con código local, prepara los archivos exactos, mensaje y destino si falta
permiso para commit/PR; una autorización de memoria no lo concede. Con PR abierto,
comprueba verificaciones y revisiones. Deja memoria estable pendiente de integración.
Si se pidió un traspaso, consérvalo como borrador de trabajo claramente identificado,
sin describirlo como estado vigente ni marcar el PR revisado en el registro.

## PR fusionado

1. Confirma número, repositorio, rama de destino, commit resultante y verificaciones.
2. Si la configuración permite el seguimiento de PR, consulta pendientes:

   ```sh
   node <toolkit>/bin/project-memory.js sync plan <bóveda>
   node <toolkit>/bin/project-memory.js sync inspect <bóveda> --pr <N>
   ```

   Revisa del más antiguo al más reciente, hasta cinco por ejecución o el alcance
   completo de la fase que el usuario pidió cerrar. La descripción del PR es
   evidencia atribuida: contrasta el comportamiento en el código integrado.
3. Enumera solo notas afectadas; sin cambio estable, usa `no-documentation-change`.
   Si la tarea tenía una nota `03-IMPLEMENTACION/Planes/<AAAA-MM-DD>-<slug>-seguimiento.md`
   con `estado: en curso`, incorpora sus decisiones confirmadas y el resultado
   final en las notas estables correspondientes y actualiza su frontmatter a
   `estado: completado`. Edita las notas con el permiso vigente y vuelve a
   revisar el diff.
4. Registra con la herramienta, primero en vista previa:

   ```sh
   node <toolkit>/bin/project-memory.js sync record <bóveda> --pr <N> --outcome documentation-updated --reviewed --summary "Resumen comprobado" --note "ruta/nota.md"
   ```

   Con resultado válido y autorización de memoria, repite con `--apply`. Pasa todas
   las notas editadas. `sync record` admite esos cambios exactos en las notas;
   mantén limpios registro y configuración, y respeta los bloqueos del diagnóstico.
   Un cambio ajeno en la bóveda no se confirma ni se descarta para desbloquearlo.
5. Si falla por `checks-missing`, `area-unresolved` u otra validación, conserva lo
   preparado y declara el registro pendiente. **No lo sustituyas por una fila
   manual «Revisado», no admitas avisos no soportados y no inventes CI.** Diferencia
   notas ya editadas de un registro aceptado. Si la inspección está bloqueada,
   detén las afirmaciones que dependan de esa evidencia antes de editar.

`sync plan`, `inspect` y `record` exigen configuración compatible, incluida
`automation.enabled`. Si está deshabilitada, indícalo y prepara la opción de
configurar seguimiento; no la actives como efecto de cerrar. Si el usuario pide
cierre documental manual y hay evidencia independiente suficiente, sigue el
mantenimiento local, dejando el seguimiento automático pendiente sin falsificar
su registro.

## Evento estable sin PR

Una decisión aprobada, despliegue comprobado o entrega estable puede tener impacto
sin PR. Verifica su evidencia y las reglas locales. Si no está claro si se trata
de un evento estable o de trabajo todavía local, aclara solo ese punto.

Con autorización, actualiza las notas pertinentes y atribuye la fuente real
(decisión, commit, entrega o despliegue). No inventes número de PR, no llames
`sync record` con identificadores ficticios y no actives automatización. Si el
proyecto tiene un registro específico de eventos, usa su formato; si no, deja
la evidencia en las notas y explica que el seguimiento de PR no aplica.

## Guardado y sincronización Git

Comprueba `memory.syncMode` y `memory.repositoryBranch`. Usa el estado real de la
bóveda, sin cambiar ramas con trabajo ajeno. Si requiere Git y hay autorización,
agrega únicamente rutas exactas, crea el commit y sincroniza con su remoto/rama
configurados. Si `syncMode=none`, las notas locales pueden estar actualizadas sin
Git; no digas «sincronizada». `git-automated` describe un modo, no prueba permiso
de ejecutar una automatización ni de hacer push en esta sesión.
