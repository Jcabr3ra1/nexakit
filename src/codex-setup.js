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
    return `""${executable}" "${entrypoint}" codex hook"`;
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
  const events = ['PostModelRequest', 'SessionStart', 'PreCompact', 'PostCompact'];
  const config = 'tool_output_token_limit = 4000\n\n[skills]\nmax_context_tokens = 2000\n\n[agents]\nmax_concurrent_threads_per_session = 2\n';
  const hooks = { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command }] }]])) };
  const readme = `# Paquete Codex: activación manual\n\nVista previa de configuración; no se activa automáticamente.\nRevisa y fusiona config.toml y hooks.json manualmente en tu CODEX_HOME.\nVerifica primero que tu versión de Codex admite estos eventos y claves.\nConfía los hooks con el flujo normal del cliente; no omitas sus confirmaciones.\nNo se garantiza compatibilidad de todos los clientes ni se cambian modelos.\nUserPromptSubmit se omite: no se ha confirmado soporte del módulo.\nEl comando del hook usa rutas absolutas: regenera el paquete si mueves NexaKit o Node.\n\nCompara muestras JSON con task, quality: { passed: true } y measurements\n(normalizeMeasurement: id, agent, phase, model, source y contadores).\nSolo se calculan porcentajes con cobertura completa y procedencia comparable.\n`;
  const files = { 'config.toml': config, 'hooks.json': JSON.stringify(hooks, null, 2) + '\n', 'README.md': readme };
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
