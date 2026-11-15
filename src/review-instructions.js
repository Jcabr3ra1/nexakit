import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const START = '<!-- nexakit:review:start -->',
  END = '<!-- nexakit:review:end -->';
const BODY = `${START}
# Método de trabajo de nexakit

Para programar sigue el proceso de Superpowers (obligatorio): contexto y
memoria, diseño y plan proporcionales, rama, pruebas, implementación,
verificación y cierre con memoria. No hace falta un comando para empezar.
Sobre sus skills mandan: no borrar código existente sin acuerdo aunque el TDD
lo pida; commits locales en ramas de trabajo sin pedir permiso; push, PR,
fusión y memoria solo con autorización. Reutiliza un diseño
o plan ya aprobado. Antes de un PR, quality-gate. Modo tutor (la persona
escribe el código, un paso verificable cada vez) solo si lo pide.

Orquesta: tú entiendes, planificas, decides e integras; delega la ejecución en
subagentes de nivel (Claude: niveles:nivel-<nivel>; Codex: nivel_<nivel>; Antigravity: nivel-<nivel>):
ligero para comandos, búsquedas y cambios mecánicos; normal para implementar
con diseño claro; exigente para pruebas, casos borde o un fallo acotado; alto
para un fallo sutil, seguridad o lo que exigente no resolvió. Trabaja tú solo
lo que se hace en uno o dos pasos y la conversación con la persona. Da a cada
subagente un encargo autocontenido (objetivo, archivos, criterio de hecho),
lanza en paralelo los independientes y comprueba su informe antes de darlo
por bueno. Si el encargo necesita el mismo contexto que ya llevas, bifurca la
sesión (fork) en vez de crear un subagente nuevo. Usa elegir-modelo para nombres reales; nunca cambies el modelo de
la sesión por tu cuenta. Sin subagentes de nivel, trabaja tú.

La revisión con varias IA es opcional: solo con /fabrica o si la persona pide
pasarlo por la fábrica; sigue la skill fabrica. Usa la orden estable
~/.nexakit/nexakit (Windows: nexakit.cmd en esa carpeta).

Si una tarea larga queda a medias —pausa, cambio de IA, bloqueo o cierre— escribe o actualiza la nota de seguimiento con project-handoff; recomienda sesión nueva en los casos de project-handoff, y cierra el seguimiento al integrar con cerrar-memoria.
${END}`;

const hash = (text) => createHash('sha256').update(text).digest('hex');
// SHA-256 of every block earlier versions of nexakit installed (from the history of this file), newest first. A block
// that matches one of them was written by nexakit even without its record in review-instructions.json, so it is
// replaced by the current one; any other text between the marks was edited by the person and is never touched.
const PREVIOUS_BODY_HASHES = new Set([
  'f1d67fb2be192ddcade136409ee59302e926c6bf41c883f6125ffb8075be41d5', // 3fa5d18: Antigravity en la orquesta
  'b02861cef24be0e67afc1870d829f375ab752980babc30a98fa187736a5247a4', // f151a93: revisión bajo demanda e informes breves
  '7f5be5b768fa60fcb785fae74492271772e4befcadf5e3d5dc60ba8203062391', // f3b8bca: subagentes de nivel
  'f564df4f5f8bf8163a916261ed6fae969b66f58104cc8a03140027b1eb1da0fa', // 043432b: Superpowers obligatorio
  '4841d522765b5630d1c8c079fb5bc0c3d6e687e937bae7654a4a020b3e684a2e', // c4761ab: traspaso y cierre
  'a59f9d7f20e328a0e990566dee78e9fe90623598bc8bd85eb593808217aae123', // d815d60: revisión certificada
  'b9ed8e99a370f760c46574fa0e1854768d35498eb70fc619337851843d97c32a', // d73e44a: revisión por sesión
]);
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
    if (before?.includes(START) && !block) {
      items.push({ ...item, state: 'conflict' });
      continue;
    }
    const blockHash = block && hash(block);
    if (block && record?.blockHash !== blockHash && blockHash !== hash(BODY) && !PREVIOUS_BODY_HASHES.has(blockHash)) {
      items.push({ ...item, state: 'conflict', reason: 'editado' });
      continue;
    }
    const prefix = before === null ? '' : before.endsWith('\n') ? before + '\n' : before + '\n\n';
    const after = block ? before.replace(block, BODY) : prefix + BODY + '\n';
    // Without a record the block was recognized by its hash: what preceded it is unknown, so a later removal only
    // takes the block out.
    const known = record?.blockHash === blockHash || !block;
    items.push({
      ...item,
      before,
      after,
      state: after === before ? 'ready' : 'pending',
      ...(block && after !== before && { update: true }),
      original: !known ? null : record ? record.original : before,
      created: !known ? false : record ? record.created : before === null,
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
