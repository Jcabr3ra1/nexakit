import fs from 'node:fs/promises';
import path from 'node:path';
import { targets, readText, checkParent, proof as readProof, blockOf as findBlock, writeAtomic, hash } from './instructions-block.js';
// Las lecciones globales vigentes, compartidas con las tres IA en un bloque propio. A diferencia del bloque de reglas
// de trabajo, su cuerpo cambia con las lecciones: la propiedad es el hash del último bloque escrito (registro).
const START = '<!-- nexakit:lecciones:start -->',
  END = '<!-- nexakit:lecciones:end -->';
export const MAX_LECCIONES_BLOQUE = 20;
export const MAX_BYTES_BLOQUE = 2048;
const proofPath = (home) => path.join(home, '.nexakit', 'lecciones-instructions.json');
const proof = (home) => readProof(proofPath(home));
const blockOf = (text) => findBlock(text, START, END);
async function cargarAlmacen() {
  try {
    return await import('../dist/fabrica/lecciones.js');
  } catch {
    return null;
  }
}
// Sin comentarios HTML ni marcadores: una regla no puede abrir ni cerrar el bloque.
function sanear(texto, limpiar) {
  let actual = limpiar(String(texto));
  for (let previo = ''; previo !== actual; ) {
    previo = actual;
    actual = limpiar(actual.replaceAll(START, '').replaceAll(END, '').replaceAll('<!--', '').replaceAll('-->', ''));
  }
  return actual;
}
/** El cuerpo del bloque con las lecciones globales vigentes, o null si no hay ninguna que aplicar. */
export function cuerpoDeLecciones(lecciones, limpiar) {
  const reglas = lecciones
    .filter((l) => l.ambito === 'global')
    .sort((a, b) => b.fecha - a.fecha)
    .map((l) => sanear(l.regla, limpiar))
    .filter(Boolean);
  const lineas = [];
  const armar = (extra) => [START, '# Lecciones de nexakit', '', ...extra, END].join('\n');
  for (const regla of reglas) {
    if (lineas.length >= MAX_LECCIONES_BLOQUE) break;
    const linea = `- ${regla}`;
    if (Buffer.byteLength(armar([...lineas, linea]), 'utf8') > MAX_BYTES_BLOQUE) break;
    lineas.push(linea);
  }
  return lineas.length ? armar(lineas) : null;
}
// `undefined`: no se pudo leer el almacén, así que no se toca nada.
async function cuerpoActual(options) {
  const almacen = options.cargarLecciones ? await options.cargarLecciones() : await cargarAlmacen();
  if (!almacen) return undefined;
  try {
    return cuerpoDeLecciones(await almacen.vigentes(options.homeDirectory), almacen.limpiarTexto);
  } catch {
    return undefined;
  }
}
export async function planLeccionesInstructions(options = {}) {
  const owned = await proof(options.homeDirectory),
    body = await cuerpoActual(options),
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
    // Un bloque que no es el último que escribimos (o que nunca escribimos) es de la persona.
    if (block && record?.blockHash !== hash(block)) {
      items.push({ ...item, state: 'conflict', reason: 'editado' });
      continue;
    }
    if (body === undefined || (!block && body === null)) {
      items.push({ ...item, before, state: 'ready' });
      continue;
    }
    if (block && body === null) {
      items.push({ ...item, before, state: 'pending', remove: true, update: true });
      continue;
    }
    const prefix = before === null ? '' : before.endsWith('\n') ? before + '\n' : before + '\n\n';
    const after = block ? before.replace(block, () => body) : prefix + body + '\n';
    items.push({
      ...item,
      before,
      after,
      blockHash: hash(body),
      state: after === before ? 'ready' : 'pending',
      ...(block && after !== before && { update: true }),
      original: block ? record.original : before,
      created: block ? record.created : before === null,
    });
  }
  return { homeDirectory: options.homeDirectory, items };
}
async function retirarBloque(item, entry, text, lock) {
  const block = blockOf(text);
  if (!block || hash(block) !== entry.blockHash) return false;
  await lock.assertHeld();
  if ((await readText(item.target)) !== text) throw new Error(`${item.name} cambió durante la retirada.`);
  const without = text.replace(block, () => '');
  if (entry.created && !without.trim()) await fs.unlink(item.target);
  else if (
    text ===
    (entry.original ?? '') + ((entry.original ?? '').endsWith('\n') ? '\n' : '\n\n') + block + '\n'
  )
    await writeAtomic(item.target, entry.original ?? '', lock);
  else await writeAtomic(item.target, without, lock);
  return true;
}
async function guardarRegistro(home, owned, lock) {
  if (!Object.keys(owned).length) {
    await lock.assertHeld();
    await fs.rm(proofPath(home), { force: true });
  } else {
    await lock.assertHeld();
    await checkParent(path.dirname(proofPath(home)), true);
    await writeAtomic(proofPath(home), JSON.stringify(owned), lock);
  }
}
export async function applyLeccionesInstructions(plan, lock) {
  const owned = await proof(plan.homeDirectory),
    pending = plan.items.filter((item) => item.state === 'pending');
  if (!pending.length) return;
  for (const item of pending) {
    await checkParent(path.dirname(item.target));
    if ((await readText(item.target)) !== item.before)
      throw new Error(`${item.name} cambió mientras confirmabas.`);
  }
  // Se retiran primero los bloques sin lecciones; el registro se guarda antes de publicar los nuevos.
  for (const item of pending.filter((i) => i.remove)) {
    if (await retirarBloque(item, owned[item.target], item.before, lock)) delete owned[item.target];
  }
  for (const item of pending.filter((i) => !i.remove))
    owned[item.target] = { client: item.client, blockHash: item.blockHash, original: item.original, created: item.created };
  await guardarRegistro(plan.homeDirectory, owned, lock);
  for (const item of pending.filter((i) => !i.remove)) {
    await lock.assertHeld();
    await checkParent(path.dirname(item.target), true);
    if ((await readText(item.target)) !== item.before)
      throw new Error(`${item.name} cambió mientras confirmabas.`);
    await writeAtomic(item.target, item.after, lock);
  }
}
export async function removeLeccionesInstructions(options, lock) {
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
    if (!(await retirarBloque(item, entry, text, lock))) continue;
    delete owned[item.target];
  }
  await guardarRegistro(options.homeDirectory, owned, lock);
}
export async function ownedLeccionesInstructions(options) {
  const owned = await proof(options.homeDirectory),
    result = [];
  for (const item of targets(options)) {
    const text = await readText(item.target).catch(() => null),
      block = blockOf(text);
    if (block && owned[item.target]?.blockHash === hash(block)) result.push(item.name);
  }
  return result;
}
