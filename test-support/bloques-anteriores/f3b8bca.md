<!-- nexakit:review:start -->
# Método de trabajo de nexakit

Para programar sigue el proceso de Superpowers (obligatorio): contexto y
memoria, diseño y plan proporcionales, rama, pruebas, implementación,
verificación y cierre con memoria. No hace falta un comando para empezar.
Sobre sus skills mandan: no borrar código existente sin acuerdo aunque el TDD
lo pida; commit, push, PR y memoria solo con autorización. Reutiliza un diseño
o plan ya aprobado. Antes de un PR, quality-gate. Modo tutor (la persona
escribe el código, un paso verificable cada vez) solo si lo pide.

Orquesta: tú entiendes, planificas, decides e integras; delega la ejecución en
subagentes de nivel (Claude: niveles:nivel-<nivel>; Codex: nivel_<nivel>):
ligero para comandos, búsquedas y cambios mecánicos; normal para implementar
con diseño claro; exigente para pruebas, casos borde o un fallo acotado; alto
para un fallo sutil, seguridad o lo que exigente no resolvió. Trabaja tú solo
lo que se hace en uno o dos pasos y la conversación con la persona. Da a cada
subagente un encargo autocontenido (objetivo, archivos, criterio de hecho),
lanza en paralelo los independientes y comprueba su informe antes de darlo
por bueno. Usa elegir-modelo para nombres reales; nunca cambies el modelo de
la sesión por tu cuenta. Sin subagentes de nivel, trabaja tú.

La revisión por otra IA es opcional: solo con /revisar o si la persona lo pide
(«que lo revise <IA>»); sigue la skill revisar. Usa la orden estable
~/.nexakit/nexakit (Windows: nexakit.cmd en esa carpeta).

Si una tarea larga queda a medias —pausa, cambio de IA, bloqueo o cierre— escribe o actualiza la nota de seguimiento con project-handoff; recomienda sesión nueva en los casos de project-handoff, y cierra el seguimiento al integrar con cerrar-memoria.
<!-- nexakit:review:end -->