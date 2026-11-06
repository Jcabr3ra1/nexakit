# Comprobación manual de proyecto limpio

Esta prueba descarga los generadores oficiales vigentes y sus dependencias; no usa los simuladores de la suite.
Cada caso se ejecuta en una carpeta temporal independiente. No modifica proyectos existentes ni instala Python o
Node en el sistema. Los entornos Python viven en `.venv` y no se instalan paquetes en el Python global.

## Procedimiento en macOS y Windows

1. Con Node 24 o superior, abre una carpeta vacía y ejecuta `npx nexakit`.
2. Elige «Proyecto limpio», las partes del caso y Git con primer commit.
3. Revisa las órdenes y los requisitos de la confirmación. Si falta Python o una versión de Node, no continúes.
4. Confirma y espera a las comprobaciones. Al llegar a skills, verifica las tecnologías detectadas y sal con `q`.
5. Repite `npx nexakit`: no debe volver a preguntar limpio o empezado.
6. Comprueba el primer commit, `.gitignore`, `.env.example` cuando corresponda y `.agent-toolkit/creacion.log`.
7. En otro caso, usa una carpeta con README: «limpio» debe pedir una subcarpeta inexistente y conservar el README.
8. Prueba `q` o Ctrl+C antes de confirmar: no se crea nada. Durante la creación, Ctrl+C cancela la orden y conserva
   lo creado y el registro; no supone deshacer el proyecto.

| Caso | Selección | Comprobaciones |
| --- | --- | --- |
| React sola | React + Vite; sin backend, base de datos ni móvil | En la raíz, `npm run build` |
| React y Django | React + Vite y Django | `frontend/`: build; `backend/`: `.venv` y `manage.py check` |
| Next.js, Express y PostgreSQL | Las tres opciones; sin móvil | Build frontend, sintaxis Express, `pg`, `.env.example` |

PostgreSQL instala el controlador y escribe un ejemplo de conexión; no levanta un servidor. La prueba no exige
un PostgreSQL activo. Las versiones vigentes pueden requerir mínimos superiores a los de NexaKit.

## Evidencia de esta implementación

La suite automatizada simula los comandos externos y cubre el bucle del terminal. La comprobación real de macOS
invoca la misma orquestación de creación con los comandos reales; no automatiza la instalación posterior de skills,
memoria o agentes. El flujo de preguntas se comprueba por separado con terminal simulado.

- Equipo: macOS, Node 24.14.1, Python 3.14.4.
- Fecha de verificación: 2026-11-06.
- Los tres casos se repitieron después de las correcciones finales; resultado:

| Caso real en macOS | Resultado | Duración |
| --- | --- | --- |
| React sola | Build y primer commit correctos | 14 s |
| React y Django | Build, `manage.py check` y primer commit correctos | 16 s |
| Next.js, Express y PostgreSQL | Build, comprobación de sintaxis, `pg`, `.env.example` y primer commit correctos | 54 s |

Se inspeccionaron los archivos de cada primer commit: no incluyen `node_modules`, `.venv`, `.agent-toolkit` ni
`.env`. Todos usan el mensaje `chore: crear la base del proyecto con nexakit`. La suite final de esta sesión:
5134 pruebas, 5123 aprobadas, 11 omitidas y 0 fallos. La cancelación, el fallo de un generador, el registro de Git,
la promoción de Supabase y la continuación en una subcarpeta se verifican con comandos simulados.

- Windows: pendiente de ejecución manual en un equipo Windows; no se afirma comprobado.

## Decisiones de implementación y límites

- Se conserva el checkout y la rama pedidos por el usuario. No se ha subido ni fusionado la rama.
- Las rutas del plan son relativas al proyecto; el ejecutor controla la promoción exclusiva. Django genera dentro
  de la parte con destino `.`. Los ejecutables del `.venv` se resuelven a su ubicación final.
- Supabase necesita frontend o backend donde instalar el cliente; se rechaza una selección de solo base de datos.
  Su configuración compartida se conserva en la raíz cuando hay varias partes.
- Los generadores trabajan en una zona propia con nombre normalizado. La frontera Git temporal y `CI=1` evitan
  que Expo pregunte o inicialice un repositorio; esa frontera no se copia al resultado. Los generadores y sus
  dependencias ejecutan código: una carpeta de trabajo no es un aislamiento del sistema operativo.
- Express usa `--force` solo tras comprobar que el destino está vacío salvo los elementos ignorables; el resultado
  se promueve sin sobrescribir. Su `--git` crea `.gitignore`, no inicia un repositorio.
- Las escrituras de FastAPI preceden a la instalación. El `.venv` se crea en el destino final y nunca se mueve.
- Las respuestas confirmadas se guardan tras la primera promoción y antes de su comprobación. Al fallar se guarda
  el destino propio y se conserva lo generado; no se repite una inferencia ni un generador automáticamente.
- Los tests del flujo anterior solo añaden la selección inicial «Ya empezado»; conservan las aserciones siguientes.
- La confirmación enumera también `.venv` y Git. Las consultas de requisitos tienen tiempo límite y cancelación.
- No se afirma ejecución real de todos los generadores remotos ni de Windows/Linux. Esa verificación adicional
  sigue siendo necesaria antes de declarar todas las plataformas comprobadas.

Mejoras menores pendientes de la revisión:

- Al interrumpir una orden se registra el motivo, pero puede faltar su última salida parcial.
- Ejecutar desde `frontend/` antes de completar las respuestas normales puede repetir el selector de modo;
  ejecutar desde la raíz carga la respuesta del proyecto limpio. La raíz del proyecto continúa bien delimitada.
- El validador aún no verifica los marcadores de `envExample`; los valores distribuidos no usan marcadores.
