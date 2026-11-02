import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const setupUrl = new URL('../src/toolkit-setup.js', import.meta.url);
const cliUrl = new URL('../src/toolkit-cli.js', import.meta.url);
const environment = { PATH: '' }; // sin agy: «all» son Codex y Claude
const PROJECT_ONLY = ['frontend-design', 'web-design-guidelines', 'mcp-builder'];

async function addSkill(toolkitRoot, name) {
  await fs.mkdir(path.join(toolkitRoot, 'skills', name), { recursive: true });
  await fs.writeFile(path.join(toolkitRoot, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`);
}
async function fixture(t, names = ['alpha', 'beta']) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skills-quitadas-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDirectory = path.join(root, 'home'), toolkitRoot = path.join(root, 'toolkit');
  await fs.mkdir(homeDirectory);
  for (const name of names) await addSkill(toolkitRoot, name);
  return { root, homeDirectory, toolkitRoot };
}
const linkOf = (f, client, name) =>
  path.join(f.homeDirectory, client === 'codex' ? '.agents/skills' : '.claude/skills', name);
const exists = (file) => fs.lstat(file).then(() => true, () => false);
const stateOf = (result, client, name) => result.skills.find((s) => s.client === client && s.name === name)?.state;

test('un enlace que nexakit instaló y el usuario quitó se respeta, por IA', async (t) => {
  const f = await fixture(t), { setupToolkit } = await import(setupUrl);
  await setupToolkit({ ...f, agent: 'all', apply: true, environment });
  await fs.unlink(linkOf(f, 'codex', 'beta'));

  const preview = await setupToolkit({ ...f, agent: 'all', environment });
  assert.equal(stateOf(preview, 'codex', 'beta'), 'quitada');
  assert.equal(stateOf(preview, 'claude', 'beta'), 'instalado');
  assert.equal(stateOf(preview, 'codex', 'alpha'), 'instalado');

  await setupToolkit({ ...f, agent: 'all', apply: true, environment });
  assert.equal(await exists(linkOf(f, 'codex', 'beta')), false, 'no se vuelve a crear');
  assert.equal(await exists(linkOf(f, 'claude', 'beta')), true, 'la otra IA no se toca');
});

test('una skill que nexakit nunca instaló se crea aunque haya otras quitadas', async (t) => {
  const f = await fixture(t), { setupToolkit } = await import(setupUrl);
  await setupToolkit({ ...f, agent: 'all', apply: true, environment });
  await fs.unlink(linkOf(f, 'codex', 'beta'));
  await addSkill(f.toolkitRoot, 'gamma');

  const result = await setupToolkit({ ...f, agent: 'all', apply: true, environment });
  assert.equal(await exists(linkOf(f, 'codex', 'gamma')), true);
  assert.equal(await exists(linkOf(f, 'claude', 'gamma')), true);
  assert.equal(await exists(linkOf(f, 'codex', 'beta')), false);
  assert.equal(stateOf(result, 'codex', 'beta'), 'quitada');
});

test('si una IA se quedó sin ningún enlace de nexakit, setup la reconstruye entera', async (t) => {
  const f = await fixture(t), { setupToolkit } = await import(setupUrl);
  await setupToolkit({ ...f, agent: 'all', apply: true, environment });
  await fs.rm(path.join(f.homeDirectory, '.agents'), { recursive: true });

  const preview = await setupToolkit({ ...f, agent: 'all', environment });
  assert.equal(stateOf(preview, 'codex', 'alpha'), 'falta');
  assert.equal(stateOf(preview, 'codex', 'beta'), 'falta');
  await setupToolkit({ ...f, agent: 'all', apply: true, environment });
  assert.equal(await exists(linkOf(f, 'codex', 'alpha')), true);
  assert.equal(await exists(linkOf(f, 'codex', 'beta')), true);
});

test('reponer devuelve una skill quitada sin tocar las demás quitadas', async (t) => {
  const f = await fixture(t, ['alpha', 'beta', 'delta']), { setupToolkit } = await import(setupUrl);
  await setupToolkit({ ...f, agent: 'all', apply: true, environment });
  await fs.unlink(linkOf(f, 'codex', 'beta'));
  await fs.unlink(linkOf(f, 'codex', 'delta'));

  const result = await setupToolkit({ ...f, agent: 'all', apply: true, restore: ['beta'], environment });
  assert.equal(await exists(linkOf(f, 'codex', 'beta')), true);
  assert.equal(await exists(linkOf(f, 'codex', 'delta')), false);
  assert.equal(stateOf(result, 'codex', 'delta'), 'quitada');
});

test('las skills de catálogo por proyecto no se enlazan en global y los enlaces que ya existían no se tocan', async (t) => {
  const f = await fixture(t, ['alpha', ...PROJECT_ONLY]), { setupToolkit } = await import(setupUrl);
  const old = linkOf(f, 'codex', 'frontend-design');
  await fs.mkdir(path.dirname(old), { recursive: true });
  await fs.symlink(path.join(f.toolkitRoot, 'skills', 'frontend-design'), old, process.platform === 'win32' ? 'junction' : 'dir');

  const result = await setupToolkit({ ...f, agent: 'all', apply: true, environment });
  assert.deepEqual([...new Set(result.skills.map((s) => s.name))], ['alpha']);
  assert.equal(await exists(linkOf(f, 'claude', 'frontend-design')), false);
  assert.equal(await exists(linkOf(f, 'codex', 'mcp-builder')), false);
  assert.equal(await exists(linkOf(f, 'codex', 'alpha')), true);
  assert.equal(await fs.readlink(old), path.join(f.toolkitRoot, 'skills', 'frontend-design'), 'el enlace previo sigue igual');
});

test('comprobar no marca como pendiente lo que quitaste y lo cuenta aparte', async (t) => {
  const f = await fixture(t);
  const bin = path.join(f.root, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'), '', { mode: 0o755 });
  const { setupToolkit } = await import(setupUrl);
  const { runToolkitCli } = await import(cliUrl);
  const env = { PATH: bin, PATHEXT: '.CMD' };
  await setupToolkit({ ...f, toolkitRoot: REPO, agent: 'claude', apply: true, environment: env });
  const names = await fs.readdir(path.join(f.homeDirectory, '.claude/skills'));
  assert.ok(names.length >= 3);
  await fs.unlink(path.join(f.homeDirectory, '.claude/skills', names[0]));

  let out = '';
  const code = await runToolkitCli(['comprobar', '--agent', 'claude'], {
    out: (text) => { out += text; },
    err: () => {},
    options: { homeDirectory: f.homeDirectory, toolkitRoot: REPO, environment: env },
  });
  assert.equal(code, 0, out);
  assert.match(out, /✓ 1 skill que quitaste/u);
  assert.doesNotMatch(out, /pendiente/u);
});

test('setup acepta --reponer <nombre> y rechaza nombres no válidos', async (t) => {
  const f = await fixture(t);
  const { runToolkitCli } = await import(cliUrl);
  const run = async (argv) => {
    let out = '', err = '';
    const code = await runToolkitCli(argv, {
      out: (x) => { out += x; }, err: (x) => { err += x; },
      options: { homeDirectory: f.homeDirectory, toolkitRoot: f.toolkitRoot, environment },
    });
    return { code, out, err };
  };
  assert.equal((await run(['setup', '--reponer', 'beta', '--json'])).code, 0);
  assert.equal((await run(['setup', '--reponer', '../fuera'])).code, 2);
  assert.equal((await run(['comprobar', '--reponer', 'beta'])).code, 2);
});

// Enlaces creados por versiones antiguas, antes de que existiera el registro: nexakit no puede saber que eran suyos.
async function forgetInRegistry(f, target) {
  const file = path.join(f.homeDirectory, '.nexakit', 'instalaciones.json');
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  data.entradas = data.entradas.filter((entry) => entry.destino !== target);
  await fs.writeFile(file, JSON.stringify(data));
}
const registryTargets = async (f) =>
  JSON.parse(await fs.readFile(path.join(f.homeDirectory, '.nexakit', 'instalaciones.json'), 'utf8')).entradas.map((e) => e.destino);

test('omitir declara quitada una skill ausente que el registro no conocía, y ya no se recrea', async (t) => {
  const f = await fixture(t), { setupToolkit } = await import(setupUrl);
  await setupToolkit({ ...f, agent: 'all', apply: true, environment });
  const target = linkOf(f, 'claude', 'beta');
  await fs.unlink(target);
  await forgetInRegistry(f, target);
  assert.equal(stateOf(await setupToolkit({ ...f, agent: 'all', environment }), 'claude', 'beta'), 'falta', 'caso antiguo: sin omitir se recrearía');

  const omitted = await setupToolkit({ ...f, agent: 'all', apply: true, omit: ['beta'], environment });
  assert.equal(stateOf(omitted, 'claude', 'beta'), 'quitada');
  assert.equal(stateOf(omitted, 'codex', 'beta'), 'instalado', 'omitir solo afecta a donde ya falta');
  assert.ok((await registryTargets(f)).includes(target));

  await setupToolkit({ ...f, agent: 'all', apply: true, environment });
  assert.equal(await exists(target), false, 'las ejecuciones siguientes tampoco la recrean');
});

test('omitir no hace nada con una skill que sigue enlazada y la vista previa no escribe el registro', async (t) => {
  const f = await fixture(t), { setupToolkit } = await import(setupUrl);
  await setupToolkit({ ...f, agent: 'all', apply: true, environment });
  assert.equal(stateOf(await setupToolkit({ ...f, agent: 'all', apply: true, omit: ['alpha'], environment }), 'codex', 'alpha'), 'instalado');
  assert.equal(await exists(linkOf(f, 'codex', 'alpha')), true);

  const target = linkOf(f, 'claude', 'beta');
  await fs.unlink(target);
  await forgetInRegistry(f, target);
  const before = await registryTargets(f);
  const preview = await setupToolkit({ ...f, agent: 'all', omit: ['beta'], environment });
  assert.equal(stateOf(preview, 'claude', 'beta'), 'quitada');
  assert.deepEqual(await registryTargets(f), before, 'sin --apply no se escribe nada');
});

test('si se pide omitir y reponer la misma skill, gana reponer', async (t) => {
  const f = await fixture(t), { setupToolkit } = await import(setupUrl);
  await setupToolkit({ ...f, agent: 'all', apply: true, environment });
  const target = linkOf(f, 'claude', 'beta');
  await fs.unlink(target);
  await forgetInRegistry(f, target);
  await setupToolkit({ ...f, agent: 'all', apply: true, omit: ['beta'], restore: ['beta'], environment });
  assert.equal(await exists(target), true);
});

test('setup acepta --omitir <nombre> repetido y rechaza nombres no válidos', async (t) => {
  const f = await fixture(t);
  const { runToolkitCli } = await import(cliUrl);
  const run = async (argv) => {
    let out = '';
    const code = await runToolkitCli(argv, {
      out: (x) => { out += x; }, err: () => {},
      options: { homeDirectory: f.homeDirectory, toolkitRoot: f.toolkitRoot, environment },
    });
    return { code, out };
  };
  assert.equal((await run(['setup', '--omitir', 'beta', '--omitir', 'alpha', '--json'])).code, 0);
  assert.equal((await run(['setup', '--omitir', 'Bad Name'])).code, 2);
  assert.equal((await run(['doctor', '--omitir', 'beta'])).code, 2);
});
