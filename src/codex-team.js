import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { agentModels } from './agent-models.js';
import { levelAgentPlan } from './level-agents.js';

const MAX_BYTES = 128 * 1024;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const LEVEL_NAMES = ['nivel_ligero', 'nivel_normal', 'nivel_exigente', 'nivel_alto'];
const SPECIALISTS = {
  investigador: {
    steps: 25, description: 'Investiga dudas técnicas en fuentes oficiales y separa lo verificado de lo pendiente.',
    instructions: `Solo lees y buscas; no edites archivos ni hagas commit, push o PR. Los temporales, solo en el scratchpad indicado en el encargo.
Empieza por documentación, changelogs y repositorios oficiales; blogs y foros son pistas, nunca pruebas.
Por cada afirmación indica dato, fuente (URL), fecha o versión y si lo leíste o ejecutaste. Marca lo no confirmado como «no verificado», sin suposiciones.
Busca palabras clave en páginas largas y no repitas búsquedas. Si se agota el presupuesto, entrega lo conseguido y qué falta comprobar.
Entrecomilla los separadores en shell. Informe en español de máximo 300 palabras: respuesta primero, evidencia y pendientes con enlaces; detalle adicional solo en el scratchpad autorizado.`
  },
  revisor_de_calidad: {
    steps: 30, description: 'Revisa requisitos, diff y pruebas frescas con quality-gate, sin corregir el cambio.',
    instructions: `Lee y aplica la skill quality-gate con profundidad proporcional al riesgo.
No edites archivos ni hagas commit, push o PR. Describe los fallos con archivo y línea; no los corrijas.
Inspecciona tú mismo git status y git diff: otro informe es una declaración, no evidencia. Ejecuta las pruebas relevantes y lee la salida real; si ya se ejecutaron sobre el mismo árbol, declara esa evidencia sin repetirlas.
Revisa cada requisito, secretos, rutas personales y archivos ajenos. Clasifica hallazgos como Alta, Media o Baja.
Informe en español de máximo 300 palabras: Aprobado, Aprobado con observaciones, Requiere cambios o Sin evidencia suficiente; después hallazgos ubicados, comprobaciones y lo no comprobado.`
  },
  cierre_de_memoria: {
    steps: 40, description: 'Cierra la memoria únicamente cuando la persona lo haya pedido y el encargo lo documente.',
    instructions: `Actúa solo si el encargo dice por escrito que la persona ha pedido cerrar la memoria; si falta, detente y explica el motivo.
Lee y aplica cerrar-memoria. Identifica proyecto y bóveda mediante el manifiesto, valida con doctor y comprueba rama, PR fusionado y evidencia del cierre real.
Edita solo las notas afectadas de la bóveda. No cambies código, repositorio fuente, .obsidian ni secretos.
Registra PR pendientes uno por uno con la herramienta: exige registro limpio entre ellos. Commit local de bóveda solo con autorización explícita en el encargo; sin ella registra el primero y comunica los pendientes. No hagas push.
Nunca sustituyas el registro por una fila manual; si la herramienta bloquea, deja lo preparado e indica el motivo exacto.
Informe en español de máximo 200 palabras: notas, PR registrados y pendientes, doctor y línea final «Memoria <proyecto>: <estado real>.»`
  },
  subir_al_repo: {
    steps: 40, description: 'Sube y fusiona un cambio verificado solo con autorización literal «sube al repo» en el encargo.',
    instructions: `Si el encargo no dice por escrito que la persona dijo literalmente «sube al repo», detente sin actuar y devuelve ese motivo.
Comprueba git status y que no estás en main. Añade solo los archivos nombrados en el encargo.
Exige evidencia de pruebas frescas sobre el árbol actual o ejecuta las pruebas del proyecto; detente si fallan.
Commit en español con Conventional Commits: tipo(alcance): descripción, minúsculas, sin punto final, máximo 72 caracteres, sin Co-Authored-By ni firmas de herramientas.
Push de la rama sin forzar ni usar --no-verify. Crea PR con gh pr create, título y cuerpo en español sin firmas.
Espera gh pr checks <n> --watch y consulta el estado final con gh pr checks <n>. Fusiona únicamente con todas las comprobaciones verdes.
Si falla CI, lee el fallo. Solo si es claramente ajeno y pasa la ejecución hermana del mismo PR, relanza una vez la ejecución fallida; si vuelve a fallar o no es ajeno, detente.
Fusiona con gh pr merge <n> --merge; cambia a main y ejecuta git pull --ff-only. Ante cualquier denegación, detente y explica, sin rodearla.
No borres ramas ni toques archivos ajenos u otros repositorios.
Informe en español de máximo 200 palabras: PR, SHA de fusión, CI, archivos del commit y pendientes. La sesión principal verificará git log, gh pr view y main frente al remoto.`
  },
  sincronizador_docs: {
    steps: 30, description: 'Contrasta documentación y código después de un cambio y comunica discrepancias sin editar.',
    instructions: `Solo lees; no edites archivos ni hagas commit, push o PR.
Parte del cambio real con git diff o gh pr diff y anota cambios observables: comandos, opciones, nombres, rutas, mensajes y cifras (plugins, versiones, pruebas).
Busca esos términos con rg en README, docs, guías y plantillas; evita leer archivos completos si basta buscar.
Por discrepancia indica archivo:línea, afirmación actual, comportamiento del código y corrección sugerida. Lo no confirmado es «no verificado».
Ignora estilo y redacción: cuenta solo lo falso o faltante.
Informe en español de máximo 300 palabras: discrepancias primero, seguido de lo comprobado que estaba bien.`
  },
  cazador_de_flakes: {
    steps: 20, description: 'Diagnostica fallos intermitentes del CI mediante historial y evidencia, sin relanzar ejecuciones.',
    instructions: `Solo lees. Usa gh run list y gh run view. No relances ni canceles ejecuciones, no edites archivos ni hagas commit, push o PR; decidir un relanzamiento corresponde al principal.
Identifica prueba exacta, sistema, commit o PR. Examina las últimas 30 ejecuciones de main y otros PR: fallos sobre total, sistemas y resultado de la ejecución hermana del mismo commit.
Lee únicamente la parte fallida del log con --log-failed, filtrada por la prueba; nunca vuelques logs enteros.
Veredicto: INTERMITENTE si falla y pasa con el mismo código; REGRESIÓN si falla siempre desde un commit; SIN DATOS si falta evidencia. Enlaza las ejecuciones e indica si sería razonable relanzar una vez.
Informe en español de máximo 200 palabras: veredicto primero, después cifras y evidencia.`
  }
};
const NAMES = [...LEVEL_NAMES, ...Object.keys(SPECIALISTS)];
const plans = new WeakMap();
const fail = message => Object.assign(new Error(message), { code: 'codex-team' });
const digest = content => createHash('sha256').update(content).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const homeOf = (options = {}) => path.resolve(options.codexHome ?? options.environment?.CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(options.homeDirectory ?? os.homedir(), '.codex'));
const filePath = (home, name) => path.join(home, 'agents', `${name}.toml`);

async function statOrNull(target) {
  try { return await fs.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const identity = stat => ({ dev: stat.dev, ino: stat.ino });

// Never traverse a linked home or agents directory. Pin both directory identities
// across planning/writing; a newly created agents directory is allowed.
async function directories(home) {
  const result = [];
  for (const dir of [home, path.join(home, 'agents')]) {
    const stat = await statOrNull(dir);
    if (stat && !stat.isDirectory()) return null;
    result.push(stat ? { ...identity(stat), real: await fs.realpath(dir) } : null);
  }
  return result;
}

async function inspect(target) {
  const stat = await statOrNull(target);
  if (!stat) return { snapshot: { type: 'missing' }, content: null };
  const base = { ...identity(stat), size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, nlink: stat.nlink };
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) {
    return { snapshot: { type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'blocked', ...base }, content: null };
  }
  let handle;
  try {
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_BYTES || !same(identity(opened), identity(stat))) throw fail('Archivo cambiado durante lectura de snapshot.');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const end = await handle.stat();
    if (bytesRead > MAX_BYTES || bytesRead !== end.size || !same(base, { ...identity(end), size: end.size, mtimeMs: end.mtimeMs, ctimeMs: end.ctimeMs, nlink: end.nlink })) throw fail('Archivo cambiado durante lectura de snapshot.');
    const bytes = buffer.subarray(0, bytesRead);
    return { snapshot: { type: 'file', ...base, hash: digest(bytes) }, content: bytes.toString('utf8'), bytes };
  } finally { await handle?.close(); }
}

function native(name, description, instructions, pick) {
  return `# Generado por nexakit codex agentes\nname = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(description)}\nmodel = ${JSON.stringify(pick.model)}\nmodel_reasoning_effort = ${JSON.stringify(pick.effort)}\ndeveloper_instructions = ${JSON.stringify(instructions)}\n`;
}
const permissions = 'Los permisos efectivos se heredan de la sesión principal/padre; estas instrucciones de solo lectura y presupuesto son orientativas, no restricciones técnicas. No amplíes permisos.';
const common = `${permissions}\nRespeta AGENTS.md y las skills del proyecto. Haz solo el encargo; el principal decide, verifica el informe e integra. No solicites automáticamente revisiones a otra IA.`;

export async function teamPlan(options = {}) {
  const codexHome = homeOf(options);
  const dirs = await directories(codexHome);
  const observed = dirs ? await Promise.all(NAMES.map(name => inspect(filePath(codexHome, name)))) : NAMES.map(() => ({ snapshot: { type: 'blocked-directory' }, content: null }));
  const { codex, levels } = await agentModels({ codexHome });
  // The legacy formatter also reads its four targets. Only invoke it after
  // checking that those reads are bounded regular files (or missing/link/dir).
  const safeLegacy = dirs && observed.slice(0, 4).every(item => ['missing', 'file', 'symlink', 'directory'].includes(item.snapshot.type));
  const legacy = safeLegacy ? await levelAgentPlan({ codexHome }) : null;
  const limitations = [permissions, 'Los presupuestos de pasos y la longitud de informes son instrucciones orientativas. No se cambia shell, configuración, hooks ni barra.', 'Los snapshots detectan cambios conocidos; el sistema de archivos no ofrece compare-and-swap entre procesos externos para rutas.'];
  if (dirs && !safeLegacy) limitations.push('Los niveles quedan bloqueados porque el generador compartido no admite lecturas acotadas de los perfiles existentes.');
  const files = NAMES.map((name, i) => {
    const role = SPECIALISTS[name];
    const selected = role ? levels.find(entry => entry.level === (name === 'revisor_de_calidad' ? 'Exigente' : 'Normal'))?.codex : levels[i]?.codex;
    const pick = selected?.model && MODEL.test(selected.model) ? selected : null;
    let content = null;
    if (pick && codex.available) {
      if (role) content = native(name, role.description, `${common}\nPresupuesto orientativo: ${role.steps} pasos; entrega avances y pendientes si se agota.\n${role.instructions}`, pick);
      else if (legacy?.files[i]?.content) {
        const parsed = getStaticTOMLValue(parseTOML(legacy.files[i].content));
        content = native(name, parsed.description, `${parsed.developer_instructions.trim()}\n${common}\nPresupuesto orientativo: ${[15, 25, 30, 40][i]} pasos. Informe de máximo 200 palabras.`, pick);
      }
    }
    const { snapshot, content: current } = observed[i];
    const blocked = !['missing', 'file'].includes(snapshot.type) || (i < 4 && !safeLegacy);
    const state = blocked ? 'bloqueado' : !codex.available ? 'sin-catalogo' : !pick ? 'sin-modelo' : current === null ? 'nuevo' : current === content ? 'igual' : 'distinto';
    return { name, kind: role ? 'specialist' : 'level', path: filePath(codexHome, name), model: pick?.model ?? null, effort: pick?.effort ?? null, state, content, snapshot };
  });
  const plan = { codexHome, catalog: codex.available, files, limitations };
  plans.set(plan, { serialized: JSON.stringify(plan), dirs });
  return plan;
}

export async function installedTeam(options = {}) {
  const codexHome = homeOf(options);
  if (!await directories(codexHome)) return [];
  const installed = [];
  for (const name of NAMES) {
    try {
      const { snapshot, content } = await inspect(filePath(codexHome, name));
      if (snapshot.type !== 'file') continue;
      const value = getStaticTOMLValue(parseTOML(content));
      if (value.name === name && typeof value.description === 'string' && value.description.trim() && typeof value.developer_instructions === 'string' && value.developer_instructions.trim()) installed.push(name);
    } catch { /* Invalid, inaccessible, changed or oversized profiles are not installed. */ }
  }
  return installed;
}

async function checkDirectories(home, expected) {
  const current = await directories(home);
  if (!current || !expected || expected.some((dir, i) => dir && !same(dir, current[i]))) throw fail('Directorio cambiado: snapshot concurrente o enlace.');
  return current;
}

export async function writeTeam(plan, { update = false } = {}) {
  const trusted = plans.get(plan);
  if (!trusted || trusted.serialized !== JSON.stringify(plan)) throw fail('Plan inválido o modificado; genera otra vista previa con teamPlan.');
  const pending = plan.files.filter(file => file.state === 'nuevo' || (update && file.state === 'distinto'));
  if (!pending.length) return plan;
  let dirs = await checkDirectories(plan.codexHome, trusted.dirs);
  // Preflight the entire known team before any mutation, including unchanged files.
  for (const file of plan.files) {
    if (file.path !== filePath(plan.codexHome, file.name) || !NAMES.includes(file.name)) throw fail('Ruta de plan inválida.');
    const actual = await inspect(file.path);
    if (!same(actual.snapshot, file.snapshot)) throw fail(`Snapshot cambiado: ${file.name}; genera otra vista previa.`);
  }
  await fs.mkdir(plan.codexHome, { recursive: true });
  await checkDirectories(plan.codexHome, dirs);
  await fs.mkdir(path.join(plan.codexHome, 'agents'), { recursive: true });
  dirs = await checkDirectories(plan.codexHome, dirs);
  for (const file of pending) {
    await checkDirectories(plan.codexHome, dirs);
    const before = await inspect(file.path);
    if (!same(before.snapshot, file.snapshot)) throw fail(`Snapshot concurrente: ${file.name}.`);
    const temporary = path.join(plan.codexHome, 'agents', `.equipo-${randomUUID()}.tmp`);
    let backupPath;
    let displaced;
    let restored = false;
    const isOriginal = snapshot => snapshot.type === 'file' && ['hash', 'ino', 'dev', 'size', 'mtimeMs', 'nlink'].every(key => snapshot[key] === before.snapshot[key]);
    try {
      await fs.writeFile(temporary, file.content, { flag: 'wx', mode: 0o644 });
      await checkDirectories(plan.codexHome, dirs);
      const latest = await inspect(file.path);
      if (!same(latest.snapshot, file.snapshot)) throw fail(`Snapshot concurrente: ${file.name}.`);
      if (file.state === 'distinto') {
        backupPath = `${file.path}.anterior-${randomUUID()}`;
        // Exclusive backup creation preserves bytes and never follows a target link.
        await fs.writeFile(backupPath, before.bytes, { flag: 'wx', mode: 0o600 });
        const last = await inspect(file.path);
        if (!same(last.snapshot, file.snapshot)) throw fail(`Snapshot concurrente: ${file.name}.`);
        // Move the original aside, then publish exclusively. Any new concurrent
        // target survives: link() never replaces an existing entry.
        const movedPath = `${file.path}.anterior-${randomUUID()}`;
        await fs.rename(file.path, movedPath);
        const moved = await inspect(movedPath);
        if (!isOriginal(moved.snapshot)) {
          await fs.link(movedPath, file.path).catch(() => {});
          throw fail(`Snapshot concurrente: ${file.name}; original conservado en ${movedPath}.`);
        }
        displaced = movedPath;
      }
      try { await fs.link(temporary, file.path); }
      catch (error) {
        if (displaced) {
          try {
            await checkDirectories(plan.codexHome, dirs);
            if (isOriginal((await inspect(displaced)).snapshot)) {
              // Restore exclusively: a concurrent entry, including a link,
              // must survive even if it appears during this recovery attempt.
              await fs.link(displaced, file.path);
              restored = true;
            }
          } catch { /* Preserve the publication error and the exact-byte backup. */ }
        }
        if (error.code === 'EEXIST') throw fail(`Archivo concurrente preservado: ${file.name}.`);
        throw error;
      }
    } finally {
      await fs.unlink(temporary).catch(() => {});
      if (displaced) await fs.unlink(displaced).catch(() => {});
      if (backupPath) file.backupPath = backupPath;
      if (restored) {
        try {
          const recovered = await inspect(file.path);
          if (isOriginal(recovered.snapshot)) file.snapshot = recovered.snapshot;
        } catch { /* A concurrent change still requires a fresh preview. */ }
      }
      trusted.dirs = dirs;
      trusted.serialized = JSON.stringify(plan);
    }
    const published = await inspect(file.path);
    if (published.snapshot.type !== 'file' || published.snapshot.hash !== digest(file.content)) throw fail(`Archivo concurrente: ${file.name}.`);
    file.state = 'igual';
    file.snapshot = published.snapshot;
    trusted.serialized = JSON.stringify(plan);
  }
  trusted.dirs = dirs;
  trusted.serialized = JSON.stringify(plan);
  return plan;
}
