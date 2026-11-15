// Migración de una instalación anterior a la fábrica, en un HOME temporal con CLIs falsas: el MCP antiguo se cambia
// por nexakit-fabrica con las órdenes de cada IA, el bloque de instrucciones viejo pasa a hablar de /fabrica, el
// enlace de /revisar desaparece, los agentes de Codex con la marca antigua se ponen al día y `quitar` ofrece borrar
// los datos antiguos sin tocar ~/.agent-toolkit/gemini. Nada se escribe sin la confirmación de `npx nexakit`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createFakeClis } from '../test-support/fake-clis.js';
import { teamPlan } from '../src/codex-team.js';

const TOOLKIT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const exists = (file) => fs.lstat(file).then(() => true, () => false);
const START = '<!-- nexakit:review:start -->';
const END = '<!-- nexakit:review:end -->';
// El bloque que instaló nexakit 0.10 (commit f151a93), tal cual quedó en CLAUDE.md, AGENTS.md y GEMINI.md.
const OLD_BLOCK = `${START}
# Método de trabajo de nexakit

Para programar sigue el proceso de Superpowers (obligatorio): contexto y
memoria, diseño y plan proporcionales, rama, pruebas, implementación,
verificación y cierre con memoria. No hace falta un comando para empezar.
Sobre sus skills mandan: no borrar código existente sin acuerdo aunque el TDD
lo pida; commit, push, PR y memoria solo con autorización. Reutiliza un diseño
o plan ya aprobado. Antes de un PR, quality-gate. Modo tutor (la persona
escribe el código, un paso verificable cada vez) solo si lo pide.

Orquesta: tú entiendes, planificas, decides e integras; delega la ejecución en
subagentes de nivel (Claude: niveles:nivel-<nivel>; Codex: nivel_<nivel>):
ligero para comandos, búsquedas y cambios mecánicos; normal para implementar
con diseño claro; exigente para pruebas, casos borde o un fallo acotado; alto
para un fallo sutil, seguridad o lo que exigente no resolvió. Trabaja tú solo
lo que se hace en uno o dos pasos y la conversación con la persona. Da a cada
subagente un encargo autocontenido (objetivo, archivos, criterio de hecho),
lanza en paralelo los independientes y comprueba su informe antes de darlo
por bueno. Si el encargo necesita el mismo contexto que ya llevas, bifurca la
sesión (fork) en vez de crear un subagente nuevo. Usa elegir-modelo para nombres reales; nunca cambies el modelo de
la sesión por tu cuenta. Sin subagentes de nivel, trabaja tú.

La revisión por otra IA es opcional: solo con /revisar o si la persona lo pide
(«que lo revise <IA>»); sigue la skill revisar. Usa la orden estable
~/.nexakit/nexakit (Windows: nexakit.cmd en esa carpeta).

Si una tarea larga queda a medias —pausa, cambio de IA, bloqueo o cierre— escribe o actualiza la nota de seguimiento con project-handoff; recomienda sesión nueva en los casos de project-handoff, y cierra el seguimiento al integrar con cerrar-memoria.
${END}`;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const CATALOG = ['Fast and affordable model', 'Latest workhorse model', 'Frontier intelligence'].map((description, i) => ({
  slug: ['rapido', 'diario', 'frontera'][i],
  description,
  supported_reasoning_levels: ['low', 'medium', 'high'].map((effort) => ({ effort })),
}));

function capture() {
  const io = { out: '', err: '' };
  return { io, out: async (text) => { io.out += text; }, err: async (text) => { io.err += text; } };
}

async function world(t, { legacyMcp = true, fakeOptions } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'fabrica-migracion-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), repo = path.join(base, 'Punto_Motos'), bin = path.join(base, 'bin');
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(repo, { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  const oldEntry = path.join(TOOLKIT_ROOT, 'bin', 'agent-toolkit-mcp.js');
  if (legacyMcp) {
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { 'agent-toolkit-workflow': { type: 'stdio', command: 'node', args: [oldEntry], env: {} } } }),
    );
    await fs.writeFile(
      path.join(codexHome, 'config.toml'),
      `model = "gpt-6"\n\n[mcp_servers.agent-toolkit-workflow]\ncommand = "node"\nargs = [${JSON.stringify(oldEntry)}]\n`,
    );
  }
  const clis = createFakeClis(home, fakeOptions);
  clis.installBin(bin);
  const options = {
    homeDirectory: home,
    environment: { PATH: bin, HOME: home },
    toolkitRoot: TOOLKIT_ROOT,
    runCommand: clis.runCommand,
  };
  return { base, home, repo, codexHome, clis, options };
}

// Instrucciones globales de 0.10: CLAUDE.md con su prueba de propiedad, AGENTS.md sin ella (solo el hash conocido)
// y GEMINI.md con el bloque editado a mano.
async function oldInstructions(w) {
  const claude = path.join(w.home, '.claude', 'CLAUDE.md');
  const agents = path.join(w.codexHome, 'AGENTS.md');
  const gemini = path.join(w.home, '.gemini', 'GEMINI.md');
  await fs.mkdir(path.dirname(claude), { recursive: true });
  await fs.mkdir(path.dirname(gemini), { recursive: true });
  await fs.writeFile(claude, `MIS REGLAS\n\n${OLD_BLOCK}\n`);
  await fs.writeFile(agents, `${OLD_BLOCK}\n`);
  const edited = OLD_BLOCK.replace('Modo tutor', 'Modo maestro');
  await fs.writeFile(gemini, `${edited}\n`);
  await fs.mkdir(path.join(w.home, '.nexakit'), { recursive: true });
  await fs.writeFile(
    path.join(w.home, '.nexakit', 'review-instructions.json'),
    JSON.stringify({
      [claude]: { client: 'claude', blockHash: hash(OLD_BLOCK), original: 'MIS REGLAS\n', created: false },
      [gemini]: { client: 'antigravity', blockHash: hash(OLD_BLOCK), original: null, created: true },
    }),
  );
  return { claude, agents, gemini, edited };
}

// Agentes de Codex: nivel_normal escrito con la marca antigua y el mismo contenido; investigador con la marca antigua
// y otro contenido.
async function oldAgents(w) {
  await fs.writeFile(path.join(w.codexHome, 'models_cache.json'), JSON.stringify({ models: CATALOG }));
  const plan = await teamPlan({ codexHome: w.codexHome });
  const content = (name) => plan.files.find((file) => file.name === name).content;
  const mark = '# Generado por `nexakit codex agentes`.\n';
  assert.ok(content('nivel_normal').startsWith(mark));
  await fs.mkdir(path.join(w.codexHome, 'agents'), { recursive: true });
  const normal = path.join(w.codexHome, 'agents', 'nivel_normal.toml');
  const investigador = path.join(w.codexHome, 'agents', 'investigador.toml');
  await fs.writeFile(normal, content('nivel_normal').replace(mark, '# Generado por nexakit codex agentes\n'));
  const other = content('investigador').replace(mark, '# Generado por nexakit codex agentes\n').replace('Investiga', 'Busca');
  await fs.writeFile(investigador, other);
  return { normal, investigador, expectedNormal: content('nivel_normal'), other };
}

async function revisarLink(w) {
  const link = path.join(w.home, '.claude', 'skills', 'revisar');
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(path.join(TOOLKIT_ROOT, 'skills', 'revisar'), link);
  return link;
}

const servers = async (w) => ({
  claude: Object.keys(JSON.parse(await fs.readFile(w.clis.files.claudeFile, 'utf8')).mcpServers ?? {}),
  codex: await fs.readFile(w.clis.files.codexFile, 'utf8'),
});

test('el plan y comprobar muestran la migración sin escribir nada', async (t) => {
  const w = await world(t);
  const files = await oldInstructions(w);
  await oldAgents(w);
  const link = await revisarLink(w);
  const before = await servers(w);
  const { runToolkitCli } = await import('../src/toolkit-cli.js');

  const plan = capture();
  assert.equal(await runToolkitCli(['--project', w.repo], { ...plan, isTTY: false, options: w.options }), 2, plan.io.err);
  for (const ia of ['Claude Code', 'Codex']) {
    assert.match(plan.io.out, new RegExp(`^  − Retirar el MCP antiguo agent-toolkit-workflow de ${ia}$`, 'mu'));
    assert.match(plan.io.out, new RegExp(`^  \\+ Registrar nexakit-fabrica en ${ia}$`, 'mu'));
  }
  assert.match(plan.io.out, /^  ↻ Actualizar la marca de 1 agente de Codex$/mu);
  assert.match(plan.io.out, /^  ! 1 agente de Codex lleva la marca antigua y otro contenido; no lo toco/mu);
  assert.match(plan.io.out, /^  ! GEMINI\.md: el bloque de nexakit está editado a mano; no lo toco$/mu);
  assert.match(plan.io.out, /^  \+ Reglas de trabajo en tus instrucciones de Claude Code y Codex$/mu);

  const check = capture();
  await runToolkitCli(['comprobar'], { ...check, options: w.options });
  for (const ia of ['Claude Code', 'Codex']) {
    assert.match(check.io.out, new RegExp(`^! Retirar el MCP antiguo agent-toolkit-workflow de ${ia} \\(ejecuta npx nexakit\\)$`, 'mu'));
    assert.match(check.io.out, new RegExp(`^! Registrar nexakit-fabrica en ${ia} \\(ejecuta npx nexakit\\)$`, 'mu'));
  }
  assert.doesNotMatch(check.io.out, /Ya no se usa; si quieres quitarlo: .*agent-toolkit-workflow/u, 'la migración sustituye al aviso suelto');
  assert.match(check.io.out, /^! GEMINI\.md: el bloque de nexakit está editado a mano; no lo toco$/mu);
  assert.match(check.io.out, /^! CLAUDE\.md: hay reglas de trabajo nuevas \(ejecuta npx nexakit\)$/mu);
  assert.match(check.io.out, /^! 1 agente de Codex lleva la marca antigua y otro contenido; no lo toco/mu);

  assert.deepEqual(await servers(w), before, 'ni el plan ni comprobar tocan la configuración');
  assert.ok(!w.clis.calls.some((call) => call[1] === 'mcp' && ['add', 'remove'].includes(call[2])));
  assert.match(await fs.readFile(files.claude, 'utf8'), /\/revisar/u);
  assert.equal(await exists(link), true);
});

test('npx nexakit --si migra el MCP, el bloque, el enlace de revisar y la marca de los agentes', async (t) => {
  const w = await world(t);
  const files = await oldInstructions(w);
  const agents = await oldAgents(w);
  const link = await revisarLink(w);
  const { runToolkitCli } = await import('../src/toolkit-cli.js');

  const run = capture();
  const code = await runToolkitCli(['--si', '--project', w.repo], { ...run, isTTY: false, options: w.options });
  assert.equal(code, 0, run.io.out + run.io.err);
  assert.match(run.io.out, /◇ MCP de la fábrica en Claude Code/u);

  const after = await servers(w);
  assert.ok(after.claude.includes('nexakit-fabrica'), after.claude.join(', '));
  assert.ok(!after.claude.includes('agent-toolkit-workflow'));
  assert.doesNotMatch(after.codex, /agent-toolkit-workflow/u);
  assert.match(after.codex, /^\[mcp_servers\.nexakit-fabrica\]$/mu);
  assert.match(after.codex, /^model = "gpt-6"$/mu, 'el resto de config.toml se conserva');
  const entry = path.join(TOOLKIT_ROOT, 'bin', 'nexakit-fabrica-mcp.js');
  assert.deepEqual(JSON.parse(await fs.readFile(w.clis.files.claudeFile, 'utf8')).mcpServers['nexakit-fabrica'].args, [entry]);
  // Con las órdenes oficiales, y la nueva antes de retirar la vieja.
  for (const cli of ['claude', 'codex']) {
    const verbs = w.clis.calls.filter((call) => call[0] === cli && call[1] === 'mcp' && ['add', 'remove'].includes(call[2]));
    const names = verbs.map((call) => `${call[2]} ${call.includes('nexakit-fabrica') ? 'nexakit-fabrica' : call[3]}`);
    assert.deepEqual(names.slice(0, 2), ['add nexakit-fabrica', 'remove agent-toolkit-workflow'], cli);
  }
  assert.ok(w.clis.calls.some((call) => call.join(' ') === 'claude mcp remove agent-toolkit-workflow -s user'));
  assert.ok(w.clis.calls.some((call) => call.join(' ') === 'codex mcp remove agent-toolkit-workflow'));

  const claude = await fs.readFile(files.claude, 'utf8');
  assert.match(claude, /^MIS REGLAS\n/u);
  assert.match(claude, /\/fabrica/u);
  assert.doesNotMatch(claude, /\/revisar/u);
  assert.match(await fs.readFile(files.agents, 'utf8'), /\/fabrica/u, 'reconocido por el hash de una versión anterior');
  assert.equal(await fs.readFile(files.gemini, 'utf8'), `${files.edited}\n`, 'el bloque editado a mano se conserva');

  assert.equal(await exists(link), false, 'el enlace de revisar desaparece');
  assert.equal(await fs.readFile(agents.normal, 'utf8'), agents.expectedNormal);
  assert.equal(await fs.readFile(agents.investigador, 'utf8'), agents.other, 'otro contenido: no se toca');

  const again = capture();
  await runToolkitCli(['--project', w.repo], { ...again, isTTY: false, options: w.options });
  assert.doesNotMatch(again.io.out, /MCP antiguo|nexakit-fabrica|Actualizar la marca/u, 'la migración no se repite');
});

test('si una orden falla, se informa y la migración no se da por hecha', async (t) => {
  const w = await world(t, { fakeOptions: { fail: { 'claude add': true } } });
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const run = capture();
  assert.equal(await runToolkitCli(['--si', '--project', w.repo], { ...run, isTTY: false, options: w.options }), 1);
  assert.match(run.io.err, /MCP de la fábrica en Claude Code.*No se pudo registrar nexakit-fabrica en Claude Code.*claude add falló/u);
  const claude = (await servers(w)).claude;
  assert.ok(claude.includes('agent-toolkit-workflow') && !claude.includes('nexakit-fabrica'), 'sin la nueva, la vieja no se retira');
  assert.doesNotMatch((await servers(w)).codex, /agent-toolkit-workflow/u, 'Codex sí se migró');
  assert.ok(!w.clis.calls.some((call) => call.join(' ') === 'claude mcp remove agent-toolkit-workflow -s user'));

  // La siguiente vez el plan sigue ofreciendo la migración de Claude Code.
  const healed = createFakeClis(w.home);
  const plan = capture();
  await runToolkitCli(['--project', w.repo], { ...plan, isTTY: false, options: { ...w.options, runCommand: healed.runCommand } });
  assert.match(plan.io.out, /^  − Retirar el MCP antiguo agent-toolkit-workflow de Claude Code$/mu);
  assert.match(plan.io.out, /^  \+ Registrar nexakit-fabrica en Claude Code$/mu);
  assert.doesNotMatch(plan.io.out, /MCP antiguo agent-toolkit-workflow de Codex/u);
});

test('una instalación nueva registra nexakit-fabrica y el plan no muestra ninguna retirada', async (t) => {
  const w = await world(t, { legacyMcp: false });
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const plan = capture();
  await runToolkitCli(['--project', w.repo], { ...plan, isTTY: false, options: w.options });
  assert.doesNotMatch(plan.io.out, /Retirar el MCP antiguo/u);
  assert.match(plan.io.out, /^  \+ Registrar nexakit-fabrica en Claude Code$/mu);
  assert.match(plan.io.out, /^  \+ Registrar nexakit-fabrica en Codex$/mu);
  const check = capture();
  await runToolkitCli(['comprobar'], { ...check, options: w.options });
  assert.doesNotMatch(check.io.out, /MCP antiguo/u);
  assert.match(check.io.out, /^! Registrar nexakit-fabrica en Claude Code \(ejecuta npx nexakit\)$/mu);

  const run = capture();
  assert.equal(await runToolkitCli(['--si', '--project', w.repo], { ...run, isTTY: false, options: w.options }), 0, run.io.out + run.io.err);
  const after = await servers(w);
  assert.ok(after.claude.includes('nexakit-fabrica'));
  assert.match(after.codex, /^\[mcp_servers\.nexakit-fabrica\]$/mu);
  assert.ok(!w.clis.calls.some((call) => call[1] === 'mcp' && call[2] === 'remove'), 'nada que retirar');
  const again = capture();
  await runToolkitCli(['comprobar'], { ...again, options: w.options });
  assert.doesNotMatch(again.io.out, /nexakit-fabrica/u);
});

test('un nexakit-fabrica roto se repara antes de retirar el MCP antiguo', async (t) => {
  const w = await world(t);
  const dead = path.join(w.base, 'copia-borrada', 'bin', 'nexakit-fabrica-mcp.js');
  const config = JSON.parse(await fs.readFile(w.clis.files.claudeFile, 'utf8'));
  config.mcpServers['nexakit-fabrica'] = { type: 'stdio', command: 'node', args: [dead], env: {} };
  await fs.writeFile(w.clis.files.claudeFile, JSON.stringify(config));
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const plan = capture();
  await runToolkitCli(['--project', w.repo], { ...plan, isTTY: false, options: w.options });
  assert.match(plan.io.out, /^  ↻ Reparar nexakit-fabrica en Claude Code$/mu);
  assert.match(plan.io.out, /^  − Retirar el MCP antiguo agent-toolkit-workflow de Claude Code$/mu);
  assert.doesNotMatch(plan.io.out, /Registrar nexakit-fabrica en Claude Code/u);

  const run = capture();
  assert.equal(await runToolkitCli(['--si', '--project', w.repo], { ...run, isTTY: false, options: w.options }), 0, run.io.out + run.io.err);
  const calls = w.clis.calls
    .filter((call) => call[0] === 'claude' && call[1] === 'mcp' && ['add', 'remove'].includes(call[2]))
    .map((call) => `${call[2]} ${call.includes('nexakit-fabrica') ? 'nexakit-fabrica' : call[3]}`);
  assert.deepEqual(calls.slice(0, 3), ['remove nexakit-fabrica', 'add nexakit-fabrica', 'remove agent-toolkit-workflow']);
  const servidores = JSON.parse(await fs.readFile(w.clis.files.claudeFile, 'utf8')).mcpServers;
  assert.deepEqual(servidores['nexakit-fabrica'].args, [path.join(TOOLKIT_ROOT, 'bin', 'nexakit-fabrica-mcp.js')]);
  assert.equal(servidores['agent-toolkit-workflow'], undefined);
});

test('con nexakit-fabrica desactivado o ajeno no se toca nada y el MCP antiguo se queda', async (t) => {
  for (const [entry, why] of [
    [{ type: 'stdio', command: 'node', args: [path.join(TOOLKIT_ROOT, 'bin', 'nexakit-fabrica-mcp.js')], enabled: false }, 'está desactivado'],
    [{ type: 'stdio', command: 'python', args: ['otro.py'] }, 'es otro servidor'],
  ]) {
    const w = await world(t);
    const config = JSON.parse(await fs.readFile(w.clis.files.claudeFile, 'utf8'));
    config.mcpServers['nexakit-fabrica'] = entry;
    await fs.writeFile(w.clis.files.claudeFile, JSON.stringify(config));
    const { runToolkitCli } = await import('../src/toolkit-cli.js');
    const plan = capture();
    await runToolkitCli(['--project', w.repo], { ...plan, isTTY: false, options: w.options });
    assert.match(plan.io.out, new RegExp(`^  ! nexakit-fabrica ${why} en Claude Code; no lo toco ni retiro el MCP antiguo agent-toolkit-workflow$`, 'mu'));
    assert.doesNotMatch(plan.io.out, /MCP antiguo agent-toolkit-workflow de Claude Code/u);
    const run = capture();
    await runToolkitCli(['--si', '--project', w.repo], { ...run, isTTY: false, options: w.options });
    const servidores = JSON.parse(await fs.readFile(w.clis.files.claudeFile, 'utf8')).mcpServers;
    assert.deepEqual(servidores['nexakit-fabrica'], entry);
    assert.ok(servidores['agent-toolkit-workflow'], 'la persona no se queda sin MCP');
    assert.ok(!w.clis.calls.some((call) => call[0] === 'claude' && call[1] === 'mcp' && ['add', 'remove'].includes(call[2]) && call.includes('nexakit-fabrica')));
  }
});

test('a medias (la nueva registrada, la vieja sin retirar), la siguiente pasada solo reintenta la retirada', async (t) => {
  const w = await world(t, { fakeOptions: { fail: { 'claude remove': true } } });
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const run = capture();
  assert.equal(await runToolkitCli(['--si', '--project', w.repo], { ...run, isTTY: false, options: w.options }), 1);
  assert.match(run.io.err, /No se pudo retirar el MCP antiguo agent-toolkit-workflow en Claude Code.*claude remove falló/u);
  const claude = (await servers(w)).claude;
  assert.ok(claude.includes('nexakit-fabrica') && claude.includes('agent-toolkit-workflow'));

  const healed = createFakeClis(w.home);
  const options = { ...w.options, runCommand: healed.runCommand };
  const plan = capture();
  await runToolkitCli(['--project', w.repo], { ...plan, isTTY: false, options });
  assert.match(plan.io.out, /^  − Retirar el MCP antiguo agent-toolkit-workflow de Claude Code$/mu);
  assert.doesNotMatch(plan.io.out, /nexakit-fabrica en Claude Code/u);
  const retry = capture();
  await runToolkitCli(['--si', '--project', w.repo], { ...retry, isTTY: false, options });
  const mcp = healed.calls.filter((call) => call[0] === 'claude' && call[1] === 'mcp' && ['add', 'remove'].includes(call[2]));
  assert.deepEqual(mcp.map((call) => call.join(' ')), ['claude mcp remove agent-toolkit-workflow -s user']);
  assert.ok(!(await servers(w)).claude.includes('agent-toolkit-workflow'));
});

test('un MCP con el nombre antiguo que no es de nexakit no se toca', async (t) => {
  const w = await world(t, { legacyMcp: false });
  await fs.writeFile(
    w.clis.files.claudeFile,
    JSON.stringify({ mcpServers: { 'agent-toolkit': { type: 'stdio', command: 'python', args: ['mi-servidor.py'] } } }),
  );
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const plan = capture();
  await runToolkitCli(['--project', w.repo], { ...plan, isTTY: false, options: w.options });
  assert.doesNotMatch(plan.io.out, /Retirar el MCP antiguo/u);
  const run = capture();
  await runToolkitCli(['--si', '--project', w.repo], { ...run, isTTY: false, options: w.options });
  const config = JSON.parse(await fs.readFile(w.clis.files.claudeFile, 'utf8')).mcpServers;
  assert.deepEqual(config['agent-toolkit'], { type: 'stdio', command: 'python', args: ['mi-servidor.py'] });
  assert.ok(config['nexakit-fabrica'], 'la fábrica se registra con su propio nombre');
});

test('un MCP antiguo desactivado también se cambia por la fábrica', async (t) => {
  const w = await world(t);
  const config = JSON.parse(await fs.readFile(w.clis.files.claudeFile, 'utf8'));
  config.mcpServers['agent-toolkit-workflow'].enabled = false;
  await fs.writeFile(w.clis.files.claudeFile, JSON.stringify(config));
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const plan = capture();
  await runToolkitCli(['--project', w.repo], { ...plan, isTTY: false, options: w.options });
  assert.match(plan.io.out, /^  − Retirar el MCP antiguo agent-toolkit-workflow de Claude Code$/mu);
  assert.match(plan.io.out, /^  \+ Registrar nexakit-fabrica en Claude Code$/mu);
  const run = capture();
  assert.equal(await runToolkitCli(['--si', '--project', w.repo], { ...run, isTTY: false, options: w.options }), 0, run.io.err);
  const claude = (await servers(w)).claude;
  assert.ok(!claude.includes('agent-toolkit-workflow') && claude.includes('nexakit-fabrica'), claude.join(', '));
});

test('quitar --global retira nexakit-fabrica y el MCP antiguo con las órdenes oficiales', async (t) => {
  const w = await world(t);
  const fabrica = { type: 'stdio', command: 'node', args: [path.join(TOOLKIT_ROOT, 'bin', 'nexakit-fabrica-mcp.js')], env: {} };
  const config = JSON.parse(await fs.readFile(w.clis.files.claudeFile, 'utf8'));
  config.mcpServers['nexakit-fabrica'] = fabrica;
  config.mcpServers.ajeno = { type: 'stdio', command: 'python', args: ['x.py'] };
  await fs.writeFile(w.clis.files.claudeFile, JSON.stringify(config));
  await fs.appendFile(w.clis.files.codexFile, `\n[mcp_servers.nexakit-fabrica]\ncommand = "node"\nargs = [${JSON.stringify(fabrica.args[0])}]\n`);
  const { runToolkitCli } = await import('../src/toolkit-cli.js');

  const preview = capture();
  await runToolkitCli(['quitar', '--global', '--project', w.repo], { ...preview, options: w.options });
  assert.match(preview.io.out, /^  - \[global claude\] Retirar el MCP nexakit-fabrica de Claude Code$/mu);
  assert.match(preview.io.out, /^  - \[global codex\] Retirar el MCP agent-toolkit-workflow de Codex$/mu);
  assert.ok(!w.clis.calls.some((call) => call[2] === 'remove'), 'la vista previa no retira nada');

  const run = capture();
  assert.equal(await runToolkitCli(['quitar', '--global', '--si', '--project', w.repo], { ...run, options: w.options }), 0, run.io.out);
  const removes = w.clis.calls.filter((call) => call[1] === 'mcp' && call[2] === 'remove').map((call) => call.join(' '));
  assert.deepEqual(removes.sort(), [
    'claude mcp remove agent-toolkit-workflow -s user',
    'claude mcp remove nexakit-fabrica -s user',
    'codex mcp remove agent-toolkit-workflow',
    'codex mcp remove nexakit-fabrica',
  ]);
  const after = await servers(w);
  assert.deepEqual(after.claude, ['ajeno']);
  assert.doesNotMatch(after.codex, /mcp_servers/u);
  assert.match(run.io.out, /MCP retirado: nexakit-fabrica de Claude Code/u);
});

test('quitar sin --global no ofrece los datos antiguos; con --global los borra y nunca toca ~/.agent-toolkit/gemini', async (t) => {
  const w = await world(t, { legacyMcp: false });
  const workflows = path.join(w.home, '.agent-toolkit', 'workflows');
  const gemini = path.join(w.home, '.agent-toolkit', 'gemini');
  const reviewers = path.join(w.home, '.nexakit', 'revisores.json');
  await fs.mkdir(path.join(workflows, 'tarea-1'), { recursive: true });
  await fs.writeFile(path.join(workflows, 'tarea-1', 'estado.json'), '{}');
  await fs.mkdir(gemini, { recursive: true });
  await fs.writeFile(path.join(gemini, 'consumo.jsonl'), '{}\n');
  await fs.mkdir(path.dirname(reviewers), { recursive: true });
  await fs.writeFile(reviewers, '{}');
  const { runToolkitCli } = await import('../src/toolkit-cli.js');

  const local = capture();
  await runToolkitCli(['quitar', '--si', '--project', w.repo], { ...local, options: w.options });
  assert.doesNotMatch(local.io.out, /datos antiguos/iu);
  assert.equal(await exists(workflows), true);
  assert.equal(await exists(reviewers), true);

  const preview = capture();
  await runToolkitCli(['quitar', '--global', '--project', w.repo], { ...preview, options: w.options });
  assert.match(preview.io.out, /Borrar datos antiguos: ~\/\.agent-toolkit\/workflows y ~\/\.nexakit\/revisores\.json/u);
  assert.equal(await exists(workflows), true, 'la vista previa no borra');

  const run = capture();
  await runToolkitCli(['quitar', '--global', '--si', '--project', w.repo], { ...run, options: w.options });
  assert.equal(await exists(workflows), false);
  assert.equal(await exists(reviewers), false);
  assert.equal(await fs.readFile(path.join(gemini, 'consumo.jsonl'), 'utf8'), '{}\n');
});

test('quitar --global no sigue enlaces: un workflows enlazado y un revisores.json que no es archivo se conservan', async (t) => {
  const w = await world(t, { legacyMcp: false });
  const outside = path.join(w.base, 'fuera');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'mio.txt'), 'mío');
  await fs.mkdir(path.join(w.home, '.agent-toolkit'), { recursive: true });
  await fs.symlink(outside, path.join(w.home, '.agent-toolkit', 'workflows'));
  await fs.mkdir(path.join(w.home, '.nexakit', 'revisores.json'), { recursive: true });
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const preview = capture();
  await runToolkitCli(['quitar', '--global', '--project', w.repo], { ...preview, options: w.options });
  assert.doesNotMatch(preview.io.out, /Borrar datos antiguos/u);
  const run = capture();
  await runToolkitCli(['quitar', '--global', '--si', '--project', w.repo], { ...run, options: w.options });
  assert.equal(await fs.readFile(path.join(outside, 'mio.txt'), 'utf8'), 'mío');
  assert.equal(await exists(path.join(w.home, '.agent-toolkit', 'workflows')), true);
  assert.equal(await exists(path.join(w.home, '.nexakit', 'revisores.json')), true);
});

// Los textos de cada versión anterior del bloque van como fixtures (test-support/bloques-anteriores), sacados del
// historial de src/review-instructions.js: la prueba no depende de git.
const PREVIOUS = {
  '3fa5d18': 'f1d67fb2be192ddcade136409ee59302e926c6bf41c883f6125ffb8075be41d5',
  f151a93: 'b02861cef24be0e67afc1870d829f375ab752980babc30a98fa187736a5247a4',
  f3b8bca: '7f5be5b768fa60fcb785fae74492271772e4befcadf5e3d5dc60ba8203062391',
  '043432b': 'f564df4f5f8bf8163a916261ed6fae969b66f58104cc8a03140027b1eb1da0fa',
  c4761ab: '4841d522765b5630d1c8c079fb5bc0c3d6e687e937bae7654a4a020b3e684a2e',
  d815d60: 'a59f9d7f20e328a0e990566dee78e9fe90623598bc8bd85eb593808217aae123',
  d73e44a: 'b9ed8e99a370f760c46574fa0e1854768d35498eb70fc619337851843d97c32a',
};
test('cada una de las 7 versiones anteriores del bloque se reconoce por su texto y se actualiza', async (t) => {
  const { planReviewInstructions } = await import('../src/review-instructions.js');
  const fixtures = fileURLToPath(new URL('../test-support/bloques-anteriores/', import.meta.url));
  assert.deepEqual((await fs.readdir(fixtures)).sort(), Object.keys(PREVIOUS).map((sha) => `${sha}.md`).sort());
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bloques-anteriores-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const target = path.join(home, '.codex', 'AGENTS.md');
  await fs.mkdir(path.dirname(target), { recursive: true });
  for (const [sha, expected] of Object.entries(PREVIOUS)) {
    const text = await fs.readFile(path.join(fixtures, `${sha}.md`), 'utf8');
    assert.ok(text.startsWith(START) && text.endsWith(END), sha);
    assert.equal(hash(text), expected, `hash de ${sha}`);
    await fs.writeFile(target, `REGLAS\n\n${text}\n`);
    const item = (await planReviewInstructions({ homeDirectory: home, agents: ['codex'] })).items[0];
    assert.equal(item.state, 'pending', sha);
    assert.equal(item.update, true, sha);
    assert.match(item.after, /^REGLAS\n\n/u);
    assert.match(item.after, /\/fabrica/u);
    await fs.writeFile(target, `${text.replace(`${START}\n`, `${START}\nNota mía.\n`)}\n`);
    const edited = (await planReviewInstructions({ homeDirectory: home, agents: ['codex'] })).items[0];
    assert.deepEqual([edited.state, edited.reason], ['conflict', 'editado'], sha);
  }
});
