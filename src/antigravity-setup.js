import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAntigravityAgents } from './antigravity-agents.js';

const TOOL_MATCHER = 'run_command|write_file|write_to_file|edit_file|replace_file_content|multi_replace_file_content';

/** Build a safely quoted shell command invoking `nexakit antigravity <subcommand>`. */
export function buildAntigravityCommand(subcommand, {
  executable = process.execPath,
  entrypoint = fileURLToPath(new URL('../bin/nexakit.js', import.meta.url)),
  platform = process.platform,
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  for (const value of [executable, entrypoint]) {
    if (!pathApi.isAbsolute(value) || /[\0\r\n]/u.test(value)) {
      throw new Error('El comando requiere rutas absolutas seguras.');
    }
  }
  if (platform === 'win32') {
    if ([executable, entrypoint].some((value) => /[%!"\r\n]/u.test(value))) {
      throw new Error('Ruta incompatible con quoting seguro en Windows.');
    }
    return `"${executable}" "${entrypoint}" antigravity ${subcommand}`;
  }
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return `${quote(executable)} ${quote(entrypoint)} antigravity ${subcommand}`;
}

async function isDarwinSystemLink(current) {
  if (process.platform !== 'darwin' || (current !== '/tmp' && current !== '/var')) return false;
  return (await fs.realpath(current).catch(() => null)) === `/private${current}`;
}

async function assertNoSymlinkAncestors(destination) {
  let current = destination;
  while (true) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() && !(await isDarwinSystemLink(current))) {
        throw new Error('No se admiten enlaces simbólicos en el destino.');
      }
      if (current !== destination && !stat.isDirectory() && !(await isDarwinSystemLink(current))) {
        throw new Error('El padre no es una carpeta.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

const within = (root, destination) => {
  const relative = path.relative(path.resolve(root), destination);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

/** Generate manual preview or write a valid standalone Antigravity CLI plugin + statusLine package. */
export async function prepareAntigravity({
  outputDirectory,
  apply = false,
  homeDirectory = os.homedir(),
  projectRoot = process.cwd(),
} = {}) {
  if (apply && !outputDirectory) throw new Error('--apply requiere --salida.');
  const destination = outputDirectory ? path.resolve(outputDirectory) : null;
  if (destination) {
    const protectedRoots = [
      path.join(homeDirectory, '.gemini'),
      path.join(projectRoot, '.agents'),
      path.join(projectRoot, '.agent'),
      path.join(projectRoot, '_agents'),
      path.join(projectRoot, '_agent'),
    ];
    if (protectedRoots.some((root) => within(root, destination))) {
      throw new Error('El paquete debe quedar fuera de la configuración activa de Antigravity.');
    }
    await assertNoSymlinkAncestors(destination);
  }

  const statusLineCommand = buildAntigravityCommand('barra');
  const hookCommand = buildAntigravityCommand('hook');

  const pluginManifest = {
    name: 'nexakit-antigravity',
    version: '1.0.0',
    description: 'Barra statusLine, niveles/subagentes, guardarraíles, ahorro, lecciones y avisos de sesión de NexaKit para Antigravity.',
  };

  const settingsSnippet = {
    statusLine: {
      type: 'command',
      command: statusLineCommand,
      enabled: true,
      padding: 0,
      stack_with_default: false,
    },
  };

  const hooksSnippet = {
    'nexakit-antigravity': {
      SessionStart: [{ type: 'command', command: hookCommand, timeout: 5 }],
      PreInvocation: [{ type: 'command', command: hookCommand, timeout: 5 }],
      PreToolUse: [{ matcher: TOOL_MATCHER, hooks: [{ type: 'command', command: hookCommand, timeout: 5 }] }],
      PostToolUse: [{ matcher: TOOL_MATCHER, hooks: [{ type: 'command', command: hookCommand, timeout: 5 }] }],
    },
  };

  const renderedAgents = await renderAntigravityAgents();
  const readme = [
    '# Paquete Antigravity CLI: activación manual',
    '',
    'Vista previa / plugin válido para Antigravity CLI (`agy`); no modifica `~/.gemini` automáticamente.',
    '',
    '## 1. Activar la barra de estado',
    '',
    'Dentro de `agy`, ejecuta:',
    '',
    '```text',
    `/statusline ${statusLineCommand}`,
    '```',
    '',
    'O copia el bloque `statusLine` de `settings.statusline.json` dentro de `~/.gemini/antigravity-cli/settings.json`.',
    'La barra muestra modelo, esfuerzo, acierto de caché, contexto, cuota con reinicio desde el 60 % y hasta 4 subagentes recientes.',
    '',
    '## 2. Instalar hooks y subagentes (`niveles`, guardarraíles, ahorro, lecciones y sesión)',
    '',
    'Puedes instalar esta carpeta directamente como plugin en Antigravity (`agy plugin install <carpeta>`) o instalar por partes:',
    '- **Subagentes (`agents/*.md`)**: `nexakit antigravity agentes --apply` (global en `~/.gemini/config/agents/`) o `--proyecto` (`.agents/agents/`).',
    '- **Hooks (`hooks.json`)**: fusiona `nexakit-antigravity` en `~/.gemini/config/hooks.json` o `.agents/hooks.json`.',
    '',
    'Cobertura incluida:',
    '- `PreInvocation` / `SessionStart`: recomendación de modelo por tarea (sin guardar texto del prompt), recordatorio y registro de correcciones/lecciones, y avisos únicos al 60 % / 80 % de contexto y 70 % / 90 % de cuota.',
    '- `PreToolUse` / `PostToolUse`: bloqueo de comandos peligrosos, secretos en `.env`/claves y commits mal formateados (`guardarrailes`), recorte de salidas largas de pruebas/build/lint (`ahorro` vía `nexakit antigravity ejecutar`) y freno a reintentos fallidos idénticos (`lecciones`).',
    '',
    '## Limitaciones de Antigravity CLI (`agy`)',
    '',
    '- La barra aplica solo a Antigravity CLI (`agy`), no a la app de escritorio ni al IDE.',
    '- `agy` no emite evento mientras escribes (`prompt.edit`), así que la recomendación aparece al enviar el mensaje.',
    '- `subagents` en `statusLine` informa nombre, rol y estado, sin contadores de tokens por subagente.',
    '- Los comandos usan rutas absolutas: regenera el paquete si mueves NexaKit o Node.',
    '',
  ].join('\n');

  const files = {
    'plugin.json': JSON.stringify(pluginManifest, null, 2) + '\n',
    'settings.statusline.json': JSON.stringify(settingsSnippet, null, 2) + '\n',
    'hooks.json': JSON.stringify(hooksSnippet, null, 2) + '\n',
    'README.md': readme,
    ...Object.fromEntries(renderedAgents.map((agent) => [`agents/${agent.filename}`, agent.content])),
  };

  if (apply) {
    await fs.mkdir(destination, { mode: 0o700 });
    await fs.mkdir(path.join(destination, 'agents'), { mode: 0o700 });
    for (const [name, contents] of Object.entries(files)) {
      await fs.writeFile(path.join(destination, name), contents, { flag: 'wx', mode: 0o600 });
    }
  }

  return {
    applied: apply,
    outputDirectory: destination,
    statusLineCommand,
    files,
    limitations: [
      'Activación manual; aplica solo a Antigravity CLI (agy).',
      'Sin evento mientras escribes: la recomendación se evalúa al enviar vía PreInvocation.',
      'subagents en statusLine no incluye tokens por subagente.',
    ],
  };
}
