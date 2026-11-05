---
name: quality-gate
license: MIT
description: Revisa y verifica entregas contra requisitos, corrección, seguridad, pruebas y evidencia fresca antes de afirmar que un trabajo está listo, corregido o aprobado. Úsala antes de cerrar una tarea, pedir revisión cruzada, preparar commit o PR, o emitir un dictamen; aplica una comprobación breve proporcional cuando el cambio sea puramente documental o menor.
---

# Puerta de calidad y evidencia de cierre

Evidencia antes de afirmaciones, siempre. Decide si una entrega está lista, necesita cambios o carece de evidencia comprobada sobre el estado actual.

## Cuándo aplica y qué profundidad elegir

| Alcance del trabajo | Qué comprobar |
| --- | --- |
| Respuesta conceptual sin cambios en archivos | No abrir puerta de calidad; distinguir datos leídos de inferencias. |
| Cambio documental pequeño | Revisar el diff, formato (`git diff --check`) y validez de rutas o enlaces locales, sin exigir suite de código ni agentes extra. |
| Cambio de lógica, CLI, esquemas o interfaz | Revisión completa del diff, requisitos línea a línea y ejecución fresca de las pruebas relevantes y de la suite afectada. |
| Seguridad, permisos, datos críticos o migraciones | Revisión rigurosa de fronteras, permisos y regresiones (combinable con `differential-review`). |

## Evidencia fresca

Superpowers es obligatorio en nexakit: `superpowers:verification-before-completion` pone la regla de base (identificar el comando que demuestra cada afirmación, ejecutarlo completo sobre el estado actual y leer su salida real antes de afirmar nada). Esta puerta la da por aplicada y reutiliza las comprobaciones ya ejecutadas sobre el mismo árbol de trabajo; si hubo cualquier edición posterior, vuelve a verificar. Lo que añade nexakit:

- **Rol de solo lectura:** como revisor en `revision-cruzada`, inspecciona el código y declara expresamente qué comandos **no** ejecutaste.
- **Requisitos y delegaciones:** revisa cada criterio de aceptación uno por uno. Si delegaste código a un subagente o recibiste una entrega externa, inspecciona tú mismo `git status` y `git diff`; el resumen de otro agente es una declaración, no una prueba.
- **Límites declarados:** separa lo comprobado de lo pendiente o fuera de cobertura (por ejemplo, validar un archivo `SKILL.md` acredita su formato en disco, no que un cliente abierto ya lo haya cargado).

## Flujo de revisión

1. Reúne objetivo, criterios de aceptación y alcance aprobado del cambio.
2. Inspecciona el diff real y las fronteras afectadas; evita mezclar archivos ajenos.
3. Aplica [la lista de comprobación](references/review-checklist.md) proporcional al riesgo.
4. Ejecuta o verifica la evidencia fresca según la sección anterior.
5. Clasifica los hallazgos por impacto (`Alta`, `Media`, `Baja`) con ubicación exacta y evidencia reproducible.
6. Emite uno de estos resultados: `Aprobado`, `Aprobado con observaciones`, `Requiere cambios` o `Sin evidencia suficiente`.

## Reglas

- Prohibido usar «debería pasar», «parece resuelto» o «ya quedó listo» sin haber comprobado la evidencia correspondiente en el estado actual.
- Prioriza defectos funcionales, regresiones, permisos, seguridad y pruebas ausentes sobre preferencias de estilo.
- No modifiques archivos durante una revisión de lectura salvo autorización explícita, ni destruyas trabajo existente.
- En **modo `tutor`**, cuando la persona usuaria diga «listo», revisa el código real escrito y la salida de la comprobación antes de habilitar el siguiente paso; si falta evidencia o hay un fallo, mantén el paso abierto con una corrección accionable.

Puerta de evidencia adaptada parcialmente de [obra/superpowers](https://github.com/obra/superpowers) (`7.0.1`, licencia MIT en [LICENSE.txt](LICENSE.txt)).
