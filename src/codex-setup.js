import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function buildCodexHookCommand({ executable = process.execPath,
  entrypoint = fileURLToPath(new URL('../bin/nexakit.js', import.meta.url)), platform = process.platform } = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  for (const value of [executable, entrypoint]) {
    if (!pathApi.isAbsolute(value) || /[\0\r\n]/u.test(value)) throw new Error('El hook requiere rutas absolutas seguras.');
  }
  if (platform === 'win32') {
    // cmd expands percent variables and delayed ! expansions even inside quotes.
    if ([executable, entrypoint].some(value => /[%!"\r\n]/u.test(value))) throw new Error('Ruta incompatible con quoting seguro en Windows.');
    // Return shell command text; the runner owns cmd.exe's outer /s /c quotes.
    return `"${executable}" "${entrypoint}" codex hook`;
  }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  return `${quote(executable)} ${quote(entrypoint)} codex hook`;
}

async function assertNoSymlinkAncestors(destination) {
  let current = destination;
  while (true) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error('No se admiten enlaces simbólicos en el destino.');
      if (current !== destination && !stat.isDirectory()) throw new Error('El padre no es una carpeta.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
const within = (root, destination) => {
  const relative = path.relative(path.resolve(root), destination);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export async function prepareCodex({ outputDirectory, apply = false, homeDirectory = os.homedir(),
  codexHome, projectRoot = process.cwd(), environment = process.env } = {}) {
  if (apply && !outputDirectory) throw new Error('--apply requiere --salida.');
  const destination = outputDirectory ? path.resolve(outputDirectory) : null;
  if (destination) {
    const protectedRoots = [path.join(homeDirectory, '.codex'), path.join(projectRoot, '.codex'),
      codexHome ?? environment.CODEX_HOME].filter(Boolean);
    if (protectedRoots.some(root => within(root, destination))) throw new Error('El paquete debe quedar fuera de la configuración activa de Codex.');
    await assertNoSymlinkAncestors(destination);
  }
  const command = buildCodexHookCommand();
  const events = ['PostModelRequest', 'SessionStart', 'PreCompact', 'PostCompact', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop'];
  const statusLine = ['model-with-reasoning', 'context-remaining', 'five-hour-limit', 'weekly-limit',
    'total-input-tokens', 'total-output-tokens', 'git-branch'];
  const config = 'tool_output_token_limit = 4000\n\n[agents]\nmax_concurrent_threads_per_session = 2\n'
    + `\n[tui]\nstatus_line = ${JSON.stringify(statusLine)}\n`;
  const hooks = { hooks: Object.fromEntries(events.map(event => [event, [{
    ...(['PreToolUse', 'PostToolUse'].includes(event) ? { matcher: '^Bash$' } : {}),
    hooks: [{ type: 'command', command }],
  }]])) };
  const readme = `# Paquete Codex: activación manual\n\nVista previa de configuración; no se activa automáticamente.\nRevisa y fusiona config.toml y hooks.json manualmente en tu CODEX_HOME.\nVerifica primero que tu versión de Codex admite estos eventos y claves.\nConfía los hooks mediante /hooks; no omitas sus confirmaciones.\nNo se garantiza compatibilidad de todos los clientes ni se cambian modelos.\nLa barra nativa muestra modelo/esfuerzo, contexto, límites y tokens cuando están disponibles.\nUsa /statusline para ordenar campos; en terminales estrechas Codex recorta los últimos.\nUserPromptSubmit recomienda localmente según la tarea mediante avisos; no cambia el modelo.\nUsa /model para aplicar una recomendación y /status para verificar el estado activo.\nEl comando del hook usa rutas absolutas: regenera el paquete si mueves NexaKit o Node.\n\nCompara muestras JSON con task, quality: { passed: true } y measurements\n(normalizeMeasurement: id, agent, phase, model, source y contadores).\nSolo se calculan porcentajes con cobertura completa y procedencia comparable.\n`;
  const liveHooks = '\n## Salidas y subagentes\n\nPreToolUse envuelve comandos simples POSIX de pruebas/build/lint con el wrapper de salida.\nNo interpreta comandos compuestos ni shell general, no eleva permisos y no ejecuta el comando desde el hook.\nPostToolUse mantiene cobertura adicional; su sustitución depende del cliente.\nSin estado explícito informa exit_code desconocido; no acredita éxito.\nNEXAKIT_SALIDA=completa evita la reescritura y el recorte. Los logs privados pueden contener datos sensibles.\nSubagentStart/Stop registran solo metadatos; consulta nexakit codex actividad.\nAl combinar una instalación existente, agrega solo los eventos que falten y conserva los demás.\nRevisa y confía los hooks nuevos con /hooks: el paquete no modifica la confianza.\n';
  const files = { 'config.toml': config, 'hooks.json': JSON.stringify(hooks, null, 2) + '\n', 'README.md': readme + liveHooks };
  if (apply) {
    // mkdir is exclusive; no recursive creation and no overwrites of an existing destination.
    await fs.mkdir(destination, { mode: 0o700 });
    for (const [name, contents] of Object.entries(files)) {
      await fs.writeFile(path.join(destination, name), contents, { flag: 'wx', mode: 0o600 });
    }
  }
  return { applied: apply, outputDirectory: destination, files,
    limitations: ['Activación manual; comprueba compatibilidad con tu versión de Codex.'] };
}
