# Ahorro y consumo en Codex

NexaKit puede auditar el contexto, registrar contadores informados por Codex,
recortar salidas de comandos y comparar mediciones. No convierte los tokens de
una suscripción en dólares ni garantiza un porcentaje de ahorro.

## Revisar antes de cambiar

Desde el checkout de desarrollo:

```sh
node bin/nexakit.js codex auditar --project .
node bin/nexakit.js codex auditar --project . --json
node bin/nexakit.js codex preparar --salida /ruta/nueva/codex-ahorro
```

La auditoría revisa campos permitidos de configuración, metadatos de skills e
instrucciones. No ejecuta skills, consulta modelos ni muestra la configuración
completa. Informa límites de cobertura: no reproduce todas las capas de
configuración gestionada, plugins o habilidades remotas del cliente abierto.

Las recomendaciones de catálogo y salida son puntos de partida para evaluar,
no valores oficiales óptimos. Reducir mucho el catálogo puede ocultar skills;
recortar mucho una salida puede obligar a leer el log completo. No se eliminan
skills ni se cambia el modelo por una recomendación.

## Preparar los hooks

```sh
node bin/nexakit.js codex preparar --salida /ruta/nueva/codex-ahorro --apply
```

Solo crea un paquete en una carpeta nueva. El README generado explica la
activación manual y los archivos preparados. No sustituye `~/.codex/config.toml`
ni los hooks existentes. Revisa y combina los fragmentos con tu configuración;
Codex requiere confiar en los hooks antes de ejecutarlos. No uses opciones que
salten esa revisión. Respeta `CODEX_HOME` cuando la instalación lo personaliza.

El paquete incluye un observador `PostModelRequest` y orientación breve de
sesión/compactación. El observador guarda solo metadatos seleccionados y
contadores disponibles. No guarda prompts, argumentos de herramientas,
transcripciones ni mensajes de error del proveedor. Un contador ausente sigue
siendo desconocido. Su cobertura depende de que el cliente emita esos eventos.

Las configuraciones gestionadas y la orquestación en la nube pueden tener
soporte diferente. Probar el comando con un fixture no demuestra que una sesión
abierta haya cargado el hook.

## Ejecutar comandos con salida acotada

```sh
node bin/nexakit.js codex ejecutar -- npm test
NEXAKIT_SALIDA=completa node bin/nexakit.js codex ejecutar -- npm test
node bin/nexakit.js ahorro --json
```

El ejecutor recibe un programa y sus argumentos literalmente, sin un shell
implícito. Conserva el código de salida y guarda el log completo localmente;
la salida resumida conserva comienzo, final y posibles errores. Para una
tubería o redirección usa deliberadamente el shell que corresponda, por ejemplo
`codex ejecutar -- sh -c 'comando | otro'`.

En Windows los archivos `.cmd` y `.bat` necesitan un intérprete explícito;
para npm puedes ejecutar `node` con la ruta de `npm-cli.js`. No se añade un
shell automáticamente, para conservar el significado literal de los argumentos.

Los logs de comandos pueden contener información sensible: no los añadas al
repositorio ni a la memoria. Los caracteres recortados y los tokens estimados
del informe `ahorro` no equivalen al consumo total ahorrado. El ejecutor se usa
explícitamente: no intercepta todos los comandos de una sesión por instalarlo.

## Consultar y evaluar

```sh
node bin/nexakit.js codex consumo --json
node bin/nexakit.js codex comparar --antes antes.json --despues despues.json --json
```

Compara la misma tarea, un resultado que cumpla los mismos criterios y muestras
con cobertura comparable. Conserva los datos originales para revisar la
comparación. Entrada en caché ya forma parte de entrada: no se suma de nuevo.
Una muestra incompleta o un resultado de peor calidad no acredita ahorro.

Cada archivo de comparación contiene la misma identidad de tarea, una
comprobación de calidad declarada y mediciones individuales. Ejemplo ficticio
para el formato; sustituye los valores por contadores observados:

```json
{
  "task": "corregir-validacion-ejemplo",
  "quality": { "passed": true },
  "measurements": [{
    "id": "llamada-1",
    "agent": "codex",
    "phase": "implementation",
    "model": "modelo-observado",
    "source": "client-reported",
    "inputTokens": 1200,
    "cacheReadTokens": 900,
    "outputTokens": 100,
    "totalTokens": 1300,
    "durationMs": 2300
  }]
}
```

La calidad la declara quien prepara la muestra: el comparador no ejecuta las
pruebas ni verifica por sí mismo que ambas tareas fueran equivalentes. Cambios
de modelo, procedencia o fase impiden atribuir un ahorro comparable.

Para un piloto útil, elige varias tareas pequeñas y grandes y repite con y sin
la mejora. Registra modelo, esfuerzo, contexto, entrada/caché/salida, duración,
reintentos y calidad. No atribuyas diferencias de una sola tarea a NexaKit.

## Esfuerzo, delegación y contexto

- Empieza con el esfuerzo adecuado para el trabajo; reserva comprobaciones
  profundas para bugs, seguridad y casos borde. Cambiarlo sigue siendo tu decisión.
- Resuelve comandos pequeños en la sesión principal. Delega trabajos extensos
  y delimitados, con un informe breve; no dupliques una búsqueda ya delegada.
- Mantén una conversación por resultado coherente. Al compactar, conserva
  objetivo, rama, archivos, decisiones, pendientes y pruebas realmente ejecutadas.
- Selecciona MCP y skills por proyecto y evita reconfigurarlos repetidamente
  durante una tarea. La cantidad instalada no demuestra cuánto contexto consumen.

## Fuentes y compatibilidad

Documentación oficial consultada el 12 de noviembre de 2026:

- [Hooks y contadores](https://learn.chatgpt.com/docs/hooks).
- [Configuración y límites](https://learn.chatgpt.com/docs/config-file/config-reference).
- [Carga progresiva de skills](https://learn.chatgpt.com/docs/build-skills).
- [Coste de los subagentes](https://learn.chatgpt.com/docs/agent-configuration/subagents).
- [Cuota, créditos y precios](https://learn.chatgpt.com/docs/pricing).

Los mods `nexakit-ahorro`, `nexakit-sesion` y `nexakit-modelo` de Claude Code
conservan su implementación propia. Esta integración de Codex utiliza la CLI y
los eventos documentados de Codex; no supone compatibilidad de esos mods.
