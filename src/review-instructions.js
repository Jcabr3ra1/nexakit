import { RECOMMENDED_REVIEWERS } from './review-policy.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const START = '<!-- nexakit:review:start -->',
  END = '<!-- nexakit:review:end -->';
const BODY = `${START}
# Método de trabajo de nexakit

Para programar, aplica normalmente: contexto y memoria, plan proporcional,
rama, pruebas, implementación, comprobación y cierre con memoria. No hace falta
un comando para empezar a programar.

Al terminar una tarea con cambios de código, pide automáticamente UNA revisión
a otra IA, corrige los hallazgos verificables y resume el resultado. Máximo dos
rondas por tarea; si queda algo grave, avisa. Solo documentos no dispara revisión.
Si el usuario dice «sin revisión», omítela. /revisar pide una revisión adicional.
No uses hooks ni subagentes para automatizar este proceso.

Lee la skill revision-cruzada para el encargo y la ejecución de solo lectura.
Usa elegir-modelo para nombres reales y esfuerzos. Nunca cambies solo el modelo.
Usa la orden estable ~/.nexakit/nexakit (Windows: nexakit.cmd en esa carpeta).
Un fallo del comando o informe vacío no significa «sin hallazgos».

La IA revisora se elige en la terminal durante la sesión, nunca en el arranque
ni en answers. Excluye siempre a la IA que programa. Antes de cada revisión y antes de preguntar ejecuta
\`nexakit revision --disponibles --principal <IA que programa>\` (IA: claude,
codex o antigravity), sin llamadas a modelos. Ofrece las otras IA instaladas
con certificación «sí» o «pendiente»; para pendientes avisa de que la primera
vez se certifican. No ofrezcas las que tienen certificación «no». Recomendadas: Claude→${RECOMMENDED_REVIEWERS.claude},
Codex→${RECOMMENDED_REVIEWERS.codex} y Antigravity→${RECOMMENDED_REVIEWERS.antigravity}.
Primera revisión con varias opciones: «¿A dónde mando la revisión?» y marca
la recomendada. Claude usa el selector de preguntas; Codex y Antigravity una
pregunta normal. Una opción: úsala sin preguntar; ninguna: avisa que no hay
revisión. Si falta certificar un perfil instalado, informa esa necesidad.
En siguientes revisiones conserva la elección en la conversación y anuncia
«Revisando con <IA>…». «que lo revise <IA>» cambia la elección. Si desaparece,
usa la única alternativa o pregunta entre las restantes. No persistas la elección.
${END}`;

const hash = (text) => createHash('sha256').update(text).digest('hex');
const proofPath = (home) => path.join(home, '.nexakit', 'review-instructions.json');
const NAMES = { claude: 'CLAUDE.md', codex: 'AGENTS.md', antigravity: 'GEMINI.md' };
function targets({ homeDirectory, environment = {}, codexHome, agents = Object.keys(NAMES) }) {
  if (!homeDirectory || !path.isAbsolute(homeDirectory))
    throw new Error('Se requiere homeDirectory absoluto.');
  const folders = {
    claude: path.join(homeDirectory, '.claude'),
    codex: codexHome ?? environment.CODEX_HOME ?? path.join(homeDirectory, '.codex'),
    antigravity: path.join(homeDirectory, '.gemini'),
  };
  return agents
    .filter((client) => NAMES[client])
    .map((client) => ({ client, name: NAMES[client], target: path.join(folders[client], NAMES[client]) }));
}
async function readText(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error('Archivo de instrucciones o registro en conflicto.');
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function checkParent(directory, create = false) {
  const info = await fs.lstat(directory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info && (!info.isDirectory() || info.isSymbolicLink()))
    throw new Error('La carpeta de instrucciones o registro no es normal.');
  if (!info && create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
}
async function proof(home) {
  await checkParent(path.dirname(proofPath(home)));
  const text = await readText(proofPath(home));
  if (text === null) return {};
  const records = JSON.parse(text);
  if (!records || typeof records !== 'object' || Array.isArray(records))
    throw new Error('Registro de instrucciones inválido.');
  return records;
}
function blockOf(text) {
  const a = text?.indexOf(START) ?? -1,
    b = text?.indexOf(END) ?? -1;
  if (a < 0 || b <= a || text.indexOf(START, a + START.length) >= 0 || text.indexOf(END, b + END.length) >= 0)
    return null;
  return text.slice(a, b + END.length);
}
async function writeAtomic(target, text, lock) {
  await lock.assertHeld();
  const stat = await fs.lstat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const tmp = target + '.' + randomUUID();
  await fs.writeFile(tmp, text, { flag: 'wx', mode: stat?.mode ?? 0o600 });
  try {
    await lock.assertHeld();
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
export async function planReviewInstructions(options = {}) {
  const owned = await proof(options.homeDirectory),
    items = [];
  for (const item of targets(options)) {
    let before;
    try {
      await checkParent(path.dirname(item.target));
      before = await readText(item.target);
    } catch {
      items.push({ ...item, state: 'conflict' });
      continue;
    }
    const block = blockOf(before),
      record = owned[item.target];
    if ((before?.includes(START) && !block) || (block && record?.blockHash !== hash(block))) {
      items.push({ ...item, state: 'conflict' });
      continue;
    }
    const prefix = before === null ? '' : before.endsWith('\n') ? before + '\n' : before + '\n\n';
    const after = block ? before.replace(block, BODY) : prefix + BODY + '\n';
    items.push({
      ...item,
      before,
      after,
      state: after === before ? 'ready' : 'pending',
      original: record ? record.original : before,
      created: record ? record.created : before === null,
    });
  }
  return { homeDirectory: options.homeDirectory, items };
}
export async function applyReviewInstructions(plan, lock) {
  const owned = await proof(plan.homeDirectory),
    pending = plan.items.filter((item) => item.state === 'pending');
  for (const item of pending) {
    await checkParent(path.dirname(item.target));
    if ((await readText(item.target)) !== item.before)
      throw new Error(`${item.name} cambió mientras confirmabas.`);
    owned[item.target] = {
      client: item.client,
      blockHash: hash(BODY),
      original: item.original,
      created: item.created,
    };
  }
  if (!pending.length) return;
  await lock.assertHeld();
  await checkParent(path.dirname(proofPath(plan.homeDirectory)), true);
  // Record ownership before publishing blocks so an interrupted install can be resumed.
  await writeAtomic(proofPath(plan.homeDirectory), JSON.stringify(owned), lock);
  for (const item of pending) {
    await lock.assertHeld();
    await checkParent(path.dirname(item.target), true);
    if ((await readText(item.target)) !== item.before)
      throw new Error(`${item.name} cambió mientras confirmabas.`);
    await writeAtomic(item.target, item.after, lock);
  }
}
export async function removeReviewInstructions(options, lock) {
  const owned = await proof(options.homeDirectory);
  for (const item of targets(options)) {
    const entry = owned[item.target];
    if (!entry) continue;
    let text;
    try {
      await checkParent(path.dirname(item.target));
      text = await readText(item.target);
    } catch {
      continue;
    }
    const block = blockOf(text);
    if (!block || hash(block) !== entry.blockHash) continue;
    await lock.assertHeld();
    if ((await readText(item.target)) !== text) throw new Error(`${item.name} cambió durante la retirada.`);
    const without = text.replace(block, '');
    if (entry.created && !without.trim()) await fs.unlink(item.target);
    else if (
      text ===
      (entry.original ?? '') + ((entry.original ?? '').endsWith('\n') ? '\n' : '\n\n') + block + '\n'
    )
      await writeAtomic(item.target, entry.original ?? '', lock);
    else await writeAtomic(item.target, without, lock);
    delete owned[item.target];
  }
  if (!Object.keys(owned).length) {
    await lock.assertHeld();
    await fs.rm(proofPath(options.homeDirectory), { force: true });
  } else await writeAtomic(proofPath(options.homeDirectory), JSON.stringify(owned), lock);
}
export async function ownedReviewInstructions(options) {
  const owned = await proof(options.homeDirectory),
    result = [];
  for (const item of targets(options)) {
    const text = await readText(item.target).catch(() => null),
      block = blockOf(text);
    if (block && owned[item.target]?.blockHash === hash(block)) result.push(item.name);
  }
  return result;
}
