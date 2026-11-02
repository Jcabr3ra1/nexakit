---
name: project-handoff
description: Prepara un traspaso compacto entre sesiones, personas o agentes con estado comprobado, cambios, riesgos y siguiente paso. Úsala al pausar, cambiar de responsable o cerrar una etapa; no la uses para copiar toda la conversación o inventar progreso.
---

# Traspaso de proyecto y nota de seguimiento

Produce un resumen compacto y verificable que permita continuar en otra sesión o con otra IA sin reconstruir todo el contexto.

## 1. Cuándo se dispara

Una tarea se considera **larga** cuando tiene un plan de implementación de varios pasos (en `03-IMPLEMENTACION/Planes/` o `docs/superpowers/plans/`) o cuando ya acumula commits o cambios verificables en una rama y no va a completarse en la sesión actual.

Si una tarea larga queda a medias —por pausa a petición del usuario, cambio de IA, bloqueo que detiene la sesión o cierre antes de terminar la fase—, escribe o actualiza la nota de seguimiento siguiendo [la plantilla de traspaso](references/handoff-template.md).

## 2. Permiso único por sesión y ubicación en la bóveda

- **Permiso de escritura:** la bóveda está fuera del repositorio del proyecto y el MCP de memoria es estrictamente de solo lectura. Pide **una sola autorización por sesión** para crear o actualizar la nota de seguimiento usando tus **herramientas de archivos**. Si el usuario no concede permiso (o el proyecto no tiene bóveda conectada), entrega el traspaso directamente en el chat.
- **Ubicación y nombre:** `<bóveda>/03-IMPLEMENTACION/Planes/<AAAA-MM-DD>-<slug>-seguimiento.md`, reutilizando la fecha y el `<slug>` base del plan activo (o la fecha actual y el nombre de la rama sin prefijo si no hay plan). Mientras la tarea siga con `estado: en curso`, actualiza siempre esa misma nota sin crear duplicados.
- **Cierre al fusionar:** cuando la rama se integra en `main` y se ejecuta `cerrar-memoria`, las decisiones y el estado final pasan a las notas permanentes y la nota de seguimiento cambia su frontmatter a `estado: completado`.

## 3. Contenido obligatorio y prohibiciones

La nota de seguimiento incluye únicamente estas cinco secciones comprobables:

1. **Estado:** rama, base, último commit, archivos tocados, resultado real de las pruebas y qué parte del plan está hecha.
2. **Cambio de diseño:** cualquier ajuste acordado con el usuario respecto al plan original.
3. **Revisiones:** rondas de revisión ejecutadas, con qué IA y modelo, hallazgos corregidos y descartados.
4. **Pendiente:** tareas o pasos que faltan y su condición de finalización, o causa del bloqueo y qué lo desbloquea.
5. **Cómo retomar:** los comandos exactos (3–4 líneas) para verificar el árbol y continuar desde el punto exacto.

**Prohibido:** nunca escribas secretos, tokens ni credenciales; nunca vuelques conversaciones enteras ni razonamientos internos; nunca modifiques el archivo del plan en curso para meter seguimiento; y nunca ejecutes `git commit` ni `git push` automáticos en la bóveda por el mero hecho de guardar el seguimiento.

## 4. Cuándo recomendar una sesión nueva

Recomienda al usuario cerrar la sesión actual y abrir otra —**nunca la cierres por tu cuenta**, sin cerrarla nunca por su cuenta— en estos cuatro casos:

1. **Empieza una fase o una tarea grande nueva** tras terminar o dejar lista la anterior.
2. **Se instalaron o actualizaron skills o instrucciones globales** (por ejemplo, tras ejecutar `npx nexakit`), porque cada IA solo las lee al abrir la sesión.
3. **Se cambia de proyecto** o de repositorio principal.
4. **La sesión ya resumió su contexto o avisa de que va a hacerlo** por límite de ventana.

Antes de recomendar abrir una sesión nueva, escribe o actualiza primero el traspaso en la nota de seguimiento y entrega al usuario una frase corta lista para copiar al abrir la sesión nueva:

`«Retoma <tarea>; el contexto está en <nota de seguimiento>»`

No recomiendes abrir una sesión nueva entre pasos de una misma tarea mientras la sesión siga corta.

## Calidad mínima

- Cada afirmación importante debe poder rastrearse a evidencia comprobada.
- Un bloqueo debe indicar causa y qué lo desbloquea.
- El siguiente agente no debe asumir que una prueba pasó si no se ejecutó.
