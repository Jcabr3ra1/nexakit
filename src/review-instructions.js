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
Si Juan dice «sin revisión», omítela. /revisar pide una revisión adicional.
No uses hooks ni subagentes para automatizar este proceso.

Lee la skill revision-cruzada para el encargo y la ejecución de solo lectura.
Usa elegir-modelo para nombres reales y esfuerzos. Nunca cambies solo el modelo.
Usa la orden estable ~/.nexakit/nexakit (Windows: nexakit.cmd en esa carpeta).
Un fallo del comando o informe vacío no significa «sin hallazgos».

La IA revisora se elige en la terminal durante la sesión, nunca en el arranque
ni en answers. Excluye siempre a la IA que programa. Ofrece solo otras IA
instaladas, disponibles y certificadas. Recomendadas: Claude→${RECOMMENDED_REVIEWERS.claude},
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
const proofPath = (root) => path.join(root, '.agent-toolkit', 'review-instructions.json');
async function readText(file) {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) throw new Error('conflicto');
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
async function proof(root) {
  const parent = await fs.lstat(path.join(root, '.agent-toolkit')).catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (parent && (!parent.isDirectory() || parent.isSymbolicLink()))
    throw new Error('.agent-toolkit no es una carpeta normal.');
  try {
    return JSON.parse(await readText(proofPath(root))) ?? {};
  } catch (e) {
    if (e.message === 'conflicto') throw e;
    return {};
  }
}
function blockOf(text) {
  const a = text?.indexOf(START) ?? -1,
    b = text?.indexOf(END) ?? -1;
  return a >= 0 && b > a ? text.slice(a, b + END.length) : null;
}
export async function planReviewInstructions({
  projectRoot,
  agents = ['claude', 'codex', 'antigravity'],
} = {}) {
  const owned = await proof(projectRoot);
  const items = [];
  const files = [
    ...(agents.includes('codex') ? ['AGENTS.md'] : []),
    ...(agents.includes('antigravity') ? ['GEMINI.md'] : []),
    ...(agents.includes('claude') ? ['CLAUDE.md'] : []),
  ];
  for (const name of files) {
    const target = path.join(projectRoot, name);
    let before;
    try {
      before = await readText(target);
    } catch {
      items.push({ name, target, state: 'conflict' });
      continue;
    }
    const block = blockOf(before);
    if (
      (before?.includes(START) && !block) ||
      (block && block !== BODY && owned[name]?.blockHash !== hash(block))
    ) {
      items.push({ name, target, state: 'conflict' });
      continue;
    }
    const prefix = before === null ? '' : before.endsWith('\n') ? before + '\n' : before + '\n\n';
    const after = block ? before.replace(block, BODY) : prefix + BODY + '\n';
    items.push({
      name,
      target,
      before,
      after,
      state: after === before ? 'ready' : 'pending',
      original: owned[name]?.original ?? before,
      created: owned[name]?.created ?? before === null,
    });
  }
  return { projectRoot, items };
}
export async function applyReviewInstructions(plan, lock) {
  const owned = await proof(plan.projectRoot);
  // Recheck the whole plan before the first write.
  for (const i of plan.items.filter((i) => i.state === 'pending'))
    if ((await readText(i.target)) !== i.before) throw new Error(`${i.name} cambió mientras confirmabas.`);
  for (const i of plan.items.filter((i) => i.state === 'pending')) {
    await lock.assertHeld();
    if ((await readText(i.target)) !== i.before) throw new Error(`${i.name} cambió mientras confirmabas.`);
    const tmp = i.target + '.' + randomUUID();
    await fs.writeFile(tmp, i.after, { flag: 'wx' });
    try {
      await lock.assertHeld();
      await fs.rename(tmp, i.target);
    } finally {
      await fs.rm(tmp, { force: true });
    }
    owned[i.name] = { blockHash: hash(BODY), original: i.original, created: i.created };
  }
  await lock.assertHeld();
  await proof(plan.projectRoot);
  await fs.mkdir(path.dirname(proofPath(plan.projectRoot)), { recursive: true });
  const tmp = proofPath(plan.projectRoot) + '.' + randomUUID();
  await fs.writeFile(tmp, JSON.stringify(owned), { flag: 'wx', mode: 0o600 });
  try {
    await lock.assertHeld();
    await fs.rename(tmp, proofPath(plan.projectRoot));
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
export async function removeReviewInstructions(projectRoot, lock) {
  const owned = await proof(projectRoot);
  for (const [name, entry] of Object.entries(owned)) {
    if (!['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].includes(name)) continue;
    const target = path.join(projectRoot, name);
    let text;
    try {
      text = await readText(target);
    } catch {
      continue;
    }
    const block = blockOf(text);
    if (!block || hash(block) !== entry.blockHash) continue;
    await lock.assertHeld();
    if ((await readText(target)) !== text) throw new Error(`${name} cambió durante la retirada.`);
    const without = text.replace(block, '');
    if (entry.created && !without.trim()) await fs.unlink(target);
    else if (
      text ===
      (entry.original ?? '') + ((entry.original ?? '').endsWith('\n') ? '\n' : '\n\n') + block + '\n'
    )
      await fs.writeFile(target, entry.original);
    else await fs.writeFile(target, without);
  }
  await lock.assertHeld();
  await fs.rm(proofPath(projectRoot), { force: true });
}

export async function ownedReviewInstructions(projectRoot) {
  const owned = await proof(projectRoot).catch(() => ({}));
  const result = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    const text = await readText(path.join(projectRoot, name)).catch(() => null),
      block = blockOf(text);
    if (block && owned[name]?.blockHash === hash(block)) result.push(name);
  }
  return result;
}
