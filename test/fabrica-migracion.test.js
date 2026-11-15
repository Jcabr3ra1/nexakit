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

test('sin el MCP antiguo el plan no muestra la retirada', async (t) => {
  const w = await world(t, { legacyMcp: false });
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const plan = capture();
  await runToolkitCli(['--project', w.repo], { ...plan, isTTY: false, options: w.options });
  assert.doesNotMatch(plan.io.out, /Retirar el MCP antiguo|Registrar nexakit-fabrica/u);
  const check = capture();
  await runToolkitCli(['comprobar'], { ...check, options: w.options });
  assert.doesNotMatch(check.io.out, /MCP antiguo|Registrar nexakit-fabrica/u);
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
  assert.equal(config['nexakit-fabrica'], undefined);
});

test('un MCP antiguo desactivado se retira sin registrar la fábrica en su lugar', async (t) => {
  const w = await world(t);
  const config = JSON.parse(await fs.readFile(w.clis.files.claudeFile, 'utf8'));
  config.mcpServers['agent-toolkit-workflow'].enabled = false;
  await fs.writeFile(w.clis.files.claudeFile, JSON.stringify(config));
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const plan = capture();
  await runToolkitCli(['--project', w.repo], { ...plan, isTTY: false, options: w.options });
  assert.match(plan.io.out, /^  − Retirar el MCP antiguo agent-toolkit-workflow de Claude Code$/mu);
  assert.doesNotMatch(plan.io.out, /Registrar nexakit-fabrica en Claude Code/u);
  assert.match(plan.io.out, /^  \+ Registrar nexakit-fabrica en Codex$/mu);
  const run = capture();
  assert.equal(await runToolkitCli(['--si', '--project', w.repo], { ...run, isTTY: false, options: w.options }), 0, run.io.err);
  const claude = (await servers(w)).claude;
  assert.ok(!claude.includes('agent-toolkit-workflow') && !claude.includes('nexakit-fabrica'), claude.join(', '));
});

test('quitar --si borra los datos antiguos reales y nunca toca ~/.agent-toolkit/gemini', async (t) => {
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

  const preview = capture();
  await runToolkitCli(['quitar', '--project', w.repo], { ...preview, options: w.options });
  assert.match(preview.io.out, /Borrar datos antiguos: ~\/\.agent-toolkit\/workflows y ~\/\.nexakit\/revisores\.json/u);
  assert.equal(await exists(workflows), true, 'la vista previa no borra');

  const run = capture();
  await runToolkitCli(['quitar', '--si', '--project', w.repo], { ...run, options: w.options });
  assert.equal(await exists(workflows), false);
  assert.equal(await exists(reviewers), false);
  assert.equal(await fs.readFile(path.join(gemini, 'consumo.jsonl'), 'utf8'), '{}\n');
});

test('quitar no sigue enlaces: un workflows enlazado y un revisores.json que no es archivo se conservan', async (t) => {
  const w = await world(t, { legacyMcp: false });
  const outside = path.join(w.base, 'fuera');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'mio.txt'), 'mío');
  await fs.mkdir(path.join(w.home, '.agent-toolkit'), { recursive: true });
  await fs.symlink(outside, path.join(w.home, '.agent-toolkit', 'workflows'));
  await fs.mkdir(path.join(w.home, '.nexakit', 'revisores.json'), { recursive: true });
  const { runToolkitCli } = await import('../src/toolkit-cli.js');
  const preview = capture();
  await runToolkitCli(['quitar', '--project', w.repo], { ...preview, options: w.options });
  assert.doesNotMatch(preview.io.out, /Borrar datos antiguos/u);
  const run = capture();
  await runToolkitCli(['quitar', '--si', '--project', w.repo], { ...run, options: w.options });
  assert.equal(await fs.readFile(path.join(outside, 'mio.txt'), 'utf8'), 'mío');
  assert.equal(await exists(path.join(w.home, '.agent-toolkit', 'workflows')), true);
  assert.equal(await exists(path.join(w.home, '.nexakit', 'revisores.json')), true);
});
