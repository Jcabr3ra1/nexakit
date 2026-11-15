import { execFile } from 'node:child_process';
import { resolveCliInvocation } from './cli-executable.js';

const EFFORT = /-(low|medium|high|xhigh|max)$/u;

// Ejecuta `agy models` una vez, sin shell, con tiempo y salida acotados.
function runAgyModels(invocation, { environment, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      invocation.executable,
      [...invocation.argsPrefix, 'models'],
      { env: environment, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false, signal },
      (error, stdout, stderr) => {
        if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new Error('La salida de agy models supera el límite.'));
        if (error && !Number.isInteger(error.code) && !error.killed) return reject(error);
        resolve({
          status: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: Boolean(error?.killed),
        });
      },
    );
    child.stdin?.end();
  });
}

/** Parsea la salida de `agy models`: «id<TAB>etiqueta», con el esfuerzo al final del id. */
export function parseAntigravityModels(stdout) {
  return String(stdout).split('\n').flatMap((line) => {
    const [model, label] = line.split('\t');
    const effort = model?.match(EFFORT)?.[1];
    return model && label && effort
      ? [{ model, description: label, efforts: [effort], defaultEffort: effort }]
      : [];
  });
}

/**
 * Consulta los modelos de Antigravity. Devuelve `{ models, error }`; `error` es un texto
 * en español si no se pudo consultar. `runCommand(nombre, args)` permite sustituir la ejecución.
 */
export async function listAntigravityModels({
  environment = process.env,
  runCommand,
  timeoutMs = 20000,
  signal,
} = {}) {
  try {
    let result;
    if (runCommand) result = await runCommand('agy', ['models']);
    else {
      const invocation = await resolveCliInvocation({ name: 'agy', environment });
      result = await runAgyModels(invocation, { environment, timeoutMs, signal });
    }
    if (result.status !== 0 || result.timedOut) throw new Error('No se pudo consultar agy models.');
    return { models: parseAntigravityModels(result.stdout), error: null };
  } catch (e) {
    return { models: [], error: e.message };
  }
}
