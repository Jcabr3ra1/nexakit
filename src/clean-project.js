import { constants } from 'node:fs';
import { runCleanCommand } from './clean-command.js';
import { sinSecretos } from '../plugins/nexakit-panel/hooks/panel.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gitTopLevel, runGit as defaultRunGit } from './project-root.js';

const ignoredEntries = new Set(['.git', '.DS_Store', 'Thumbs.db']);
export async function inspectFolder(dir, { runGit = defaultRunGit } = {}) {
  const root = await fs.realpath(dir);
  const entries = (await fs.readdir(root)).sort();
  return { empty: entries.every(name => ignoredEntries.has(name)), insideGit: Boolean(await gitTopLevel(root, runGit)), entries };
}
export function projectName(dir) {
  const normalized = path.basename(dir).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 214).replace(/-+$/g, '');
  return normalized || 'proyecto';
}

// Pure plan: cwd and write paths are relative to the selected project root.
// The executor (a later task) owns venv creation, confinement and exclusive writes.
export function planCleanProject({ choice, catalog, name, platform = process.platform }) {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw new Error('Elección de proyecto inválida.');
  const order = ['frontend', 'backend', 'mobile'];
  for (const part of Object.keys(choice)) if (![...order, 'database'].includes(part)) throw new Error(`Parte desconocida: ${part}.`);
  const selected = {};
  for (const part of [...order, 'database']) {
    if (choice[part] == null) continue;
    const generator = catalog.generators.find(g => g.id === choice[part] && g.part === part);
    if (!generator) throw new Error(`Elección inválida para ${part}.`);
    selected[part] = generator;
  }
  const database = selected.database;
  if (database && database.id !== 'supabase' && !selected.backend) throw new Error('Esta base de datos necesita un backend.');
  const hostPart = database?.id === 'supabase' && selected.frontend ? 'frontend' : 'backend';
  if (database && !selected[hostPart]) throw new Error('La base de datos necesita un frontend o backend.');
  const hostConfig = database?.database.backends[selected[hostPart]?.id];
  if (database && !hostConfig) throw new Error('La base de datos no admite la parte elegida.');
  const count = order.filter(part => selected[part]).length;
  const venvBin = platform === 'win32' ? '.venv\\Scripts' : '.venv/bin';
  const python = platform === 'win32' ? `${venvBin}\\python.exe` : `${venvBin}/python`;
  const normalizedName = projectName(name);
  const parts = order.filter(part => selected[part]).map(part => {
    const g = selected[part], dir = count === 1 ? '.' : part === 'mobile' ? 'movil' : part;
    const substitutions = { dir, name: normalizedName, python, venvBin };
    const expand = value => value.replace(/\{(dir|name|python|venvBin)\}(\/)?/g, (_, key, slash) =>
      substitutions[key] + (slash ? key === 'venvBin' && platform === 'win32' ? '\\' : '/' : ''));
    const commands = [], writes = [];
    const append = (steps, root = false) => {
      for (const step of steps) {
        if (step.kind === 'run') commands.push({ argv: step.argv.map(expand), cwd: root || step.cwd === 'parent' ? '.' : dir });
        else writes.push({ path: path.posix.join(dir, expand(step.path)), content: expand(step.content) });
      }
    };
    append(g.steps); append(g.install);
    if (database && part === hostPart) {
      append(database.steps, true); append(database.install, true); append(hostConfig.install);
      if (hostConfig.envExample) writes.push({ path: path.posix.join(dir, '.env.example'), content: expand(hostConfig.envExample) });
    }
    return { part, id: g.id, dir, commands, writes, check: { argv: g.check.argv.map(expand), cwd: dir } };
  });
  const pythonUsed = Object.values(selected).some(g => g.requires.some(r => r.program === 'python'));
  return { parts, databaseId: database?.id ?? null, gitignore: [...(pythonUsed ? ['.venv/'] : []), '.env'] };
}

export async function checkRequirements(plan, catalog, { runCommand, platform = process.platform }) {
  const required = new Map();
  for (const id of [...plan.parts.map(p => p.id), plan.databaseId].filter(Boolean)) {
    for (const requirement of catalog.generators.find(g => g.id === id).requires) {
      const previous = required.get(requirement.program);
      if (!previous || compareVersions(requirement.minVersion, previous) > 0) required.set(requirement.program, requirement.minVersion);
    }
  }
  const results = [];
  for (const [program, minVersion] of required) {
    let found = null;
    try {
      const result = await runCommand(program === 'python' ? platform === 'win32' ? 'py' : 'python3' : 'node', ['--version']);
      const output = typeof result === 'string' ? result : result?.status === 0 || result?.code === 0 ? result.stdout : '';
      found = String(output ?? '').match(/\b(?:v|Python\s+)?(\d+\.\d+(?:\.\d+)?)\b/)?.[1] ?? null;
    } catch { /* Missing programs are a blocking result, not an exception. */ }
    results.push({ program, minVersion, found, ok: found !== null && compareVersions(found, minVersion) >= 0 });
  }
  return results;
}
function compareVersions(a, b) {
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((aa[i] ?? 0) !== (bb[i] ?? 0)) return (aa[i] ?? 0) - (bb[i] ?? 0);
  return 0;
}

const lstatOrNull = full => fs.lstat(full).catch(e => { if(e.code === 'ENOENT') return null; throw e; });
async function physicalDirectory(full) {
  const stat = await lstatOrNull(full);
  if (!stat) { await fs.mkdir(full); return; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('La carpeta de destino no es segura.');
}
function confined(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.includes(':') || relative.split('/').includes('..')) throw Error('Ruta fuera del proyecto.');
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) throw Error('Ruta fuera del proyecto.');
  return full;
}
async function copyExclusive(source, destination, sourceRoot, destinationRoot) {
  for (const entry of await fs.readdir(source, {withFileTypes:true})) {
    if (entry.name === '.git') throw Error('El generador intentó crear un repositorio Git propio.');
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) { await fs.mkdir(to); await copyExclusive(from,to,sourceRoot,destinationRoot); }
    else if (entry.isFile()) await fs.copyFile(from,to,constants.COPYFILE_EXCL);
    else if (entry.isSymbolicLink()) {
      const target = await fs.readlink(from), resolved = path.resolve(path.dirname(from),target);
      if (path.isAbsolute(target) || !resolved.startsWith(sourceRoot + path.sep)) throw Error('Enlace generado fuera del proyecto.');
      await fs.symlink(target,to);
    } else throw Error('Archivo generado no admitido.');
  }
}
export async function runCleanProject(plan, { projectRoot, runCommand = runCleanCommand, onProgress = () => {}, now = Date.now,
  timeoutMs = 600000, platform = process.platform } = {}) {
  const root = await fs.realpath(projectRoot), done = [], log = []; let workspace, current = plan.parts[0]?.part ?? 'proyecto', argv = [];
  const toolkit = path.join(root,'.agent-toolkit');
  const record = text => log.push(`${new Date(now()).toISOString()} ${sinSecretos(text)}`);
  const command = async (values,cwd) => {
    argv = values; onProgress(current,values); record(values.join(' '));
    const controller = new AbortController(); let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(()=>runCommand(values[0],values.slice(1),{cwd,signal:controller.signal,timeoutMs,
          env:{...process.env,CI:'1',npm_config_cache:path.join(workspace,'npm-cache')}})),
        new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('La orden superó el tiempo límite.'));},timeoutMs);})
      ]);
      const status = result?.status ?? result?.code;
      const output = typeof result === 'string' ? result : `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
      record(`salida ${status ?? 0}: ${output}`);
      if (typeof result !== 'string' && status !== 0) throw Error(output || 'La orden falló.');
    } finally { clearTimeout(timer); }
  };
  try {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw Error('Tiempo límite inválido.');
    const entries = await fs.readdir(root);
    if (entries.some(n=>!ignoredEntries.has(n))) throw Error('La carpeta contiene archivos existentes; no se sobrescribirá nada.');
    await physicalDirectory(toolkit);
    workspace = await fs.mkdtemp(path.join(toolkit,'creacion-'));
    // A temporary Git boundary prevents upstream generators (Expo) initializing
    // or prompting about Git. It is never copied into the actual project.
    const git = path.join(workspace,'.git'); await fs.mkdir(git);
    for (const sub of ['objects','refs']) await fs.mkdir(path.join(git,sub));
    await fs.writeFile(path.join(git,'HEAD'),'ref: refs/heads/main\n',{flag:'wx'});
    await fs.writeFile(path.join(git,'config'),'[core]\nrepositoryformatversion = 0\nbare = false\n',{flag:'wx'});
    const stage = path.join(workspace,projectName(root)); await fs.mkdir(stage);
    for (const part of plan.parts) {
      current = part.part; const dir = confined(stage,part.dir);
      const pythonUsed = part.commands.some(c=>/\.venv[\\/]/.test(c.argv[0]));
      if (pythonUsed || part.writes.length) await physicalDirectory(dir);
      const destination = confined(root,part.dir);
      if (destination !== root) await fs.mkdir(destination);
      if (pythonUsed) await command([platform === 'win32' ? 'py' : 'python3','-m','venv','.venv'],destination);
      const finalArgv = values => values.map(value => /^\.venv[\\/]/.test(value) ? path.join(destination, ...value.split(/[\\/]/)) : value);
      for (const w of part.writes) {
        const full = confined(stage,w.path); await fs.writeFile(full,w.content,{flag:'wx'});
      }
      for (const c of part.commands) await command(finalArgv(c.argv),confined(stage,c.cwd));
      await copyExclusive(dir,destination,stage,root);
      await command(finalArgv(part.check.argv),destination); done.push(part.part);
    }
    record('Creación comprobada.');
    await fs.rm(workspace,{recursive:true});
    return {ok:true,done};
  } catch(error) {
    const output = sinSecretos(error.message ?? String(error)); record(output);
    return {ok:false,done,failed:{part:current,argv,output},...(workspace && {workspace})};
  } finally {
    // An unsafe .agent-toolkit is not followed even to save an error report.
    try {
      await physicalDirectory(toolkit);
      const file = path.join(toolkit,'creacion.log'), stat = await lstatOrNull(file);
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw Error('Registro inseguro.');
      await fs.appendFile(file,log.join('\n')+'\n',{mode:0o600});
    } catch(error) {
      return {ok:false,done,failed:{part:current,argv,output:sinSecretos(`No se pudo guardar el registro: ${error.message}`)}};
    }
  }
}

export async function initGit(projectRoot, {runCommand = runCleanCommand, insideGit, gitignore = []} = {}) {
  if (insideGit) return 'omitido-repo-existente';
  const root = await fs.realpath(projectRoot);
  const run = async args => {
    const result = await runCommand('git',args,{cwd:root,signal:AbortSignal.timeout(30000)});
    if (typeof result !== 'string' && (result?.status ?? result?.code) !== 0) throw Error('Git no completó la orden.');
  };
  try { await run(['--version']); } catch { return 'sin-git'; }
  const file=path.join(root,'.gitignore'), stat=await lstatOrNull(file);
  if(stat && (!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>1024*1024)) throw Error('.gitignore no es un archivo seguro.');
  const text=stat ? await fs.readFile(file,'utf8') : '';
  const lines = new Set(text.split(/\r?\n/));
  const missing = [...new Set([...gitignore,'.agent-toolkit/'])].filter(line=>!lines.has(line));
  if(missing.length) await fs.appendFile(file,`${text && !text.endsWith('\n')?'\n':''}${missing.join('\n')}\n`);
  await run(['init']); await run(['add','-A']); await run(['commit','-m','chore: crear la base del proyecto con nexakit']);
  return 'hecho';
}
