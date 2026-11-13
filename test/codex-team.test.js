import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import * as team from '../src/codex-team.js';
import { levelAgentPlan, writeLevelAgents } from '../src/level-agents.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-team-'));
after(() => fs.rm(root, { recursive: true, force: true }));
const names = ['nivel_ligero', 'nivel_normal', 'nivel_exigente', 'nivel_alto', 'investigador', 'revisor_de_calidad', 'cierre_de_memoria', 'subir_al_repo', 'sincronizador_docs', 'cazador_de_flakes'];
const catalog = ['Fast and affordable model', 'Latest workhorse model', 'Frontier intelligence'].map((description, i) => ({
  slug: ['rapido', 'diario', 'frontera'][i], description,
  supported_reasoning_levels: ['low', 'medium', 'high'].map(effort => ({ effort }))
}));
async function home(models = catalog) {
  const codexHome = await fs.mkdtemp(path.join(root, 'case-'));
  if (models) await fs.writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models }));
  return codexHome;
}
const target = (h, name = 'nivel_normal') => path.join(h, 'agents', `${name}.toml`);
const parse = text => getStaticTOMLValue(parseTOML(text));

test('preview is immutable, has exact schema, ten valid native profiles and catalog choices', async () => {
  assert.equal(typeof team.teamPlan, 'function');
  const codexHome = await home();
  const plan = await team.teamPlan({ environment: { CODEX_HOME: codexHome } });
  assert.deepEqual(Object.keys(plan).sort(), ['catalog', 'codexHome', 'files', 'limitations']);
  assert.equal(plan.codexHome, codexHome);
  assert.deepEqual(plan.files.map(f => f.name), names);
  for (const [i, file] of plan.files.entries()) {
    assert.deepEqual(Object.keys(file).sort(), ['content', 'effort', 'kind', 'model', 'name', 'path', 'snapshot', 'state']);
    assert.equal(file.state, 'nuevo');
    assert.equal(file.kind, i < 4 ? 'level' : 'specialist');
    const native = parse(file.content);
    assert.equal(native.name, file.name);
    assert.equal(native.model, file.model);
    assert.equal(native.model_reasoning_effort, file.effort);
    assert.ok(native.developer_instructions.length > 200);
    assert.doesNotMatch(file.content, /revision-cruzada|maxTurns|sandbox_mode|tools\s*=/u);
    assert.match(native.developer_instructions, /permisos.*(?:padre|principal)/iu);
  }
  assert.equal(plan.files[5].effort, 'high');
  assert.ok(plan.files.slice(4).filter(f => f.name !== 'revisor_de_calidad').every(f => f.model === 'diario' && f.effort === 'medium'));
  assert.match(plan.files[7].content, /sube al repo/u);
  assert.match(plan.files[6].content, /persona.*pedido/iu);
  assert.match(plan.limitations.join(' '), /permisos/iu);
  await assert.rejects(fs.access(path.join(codexHome, 'agents')));
});

test('creates once, returns same shape and discovers without model catalog', async () => {
  const codexHome = await home();
  const result = await team.writeTeam(await team.teamPlan({ codexHome }));
  assert.ok(result.files.every(f => f.state === 'igual'));
  assert.deepEqual(await team.installedTeam({ codexHome }), names);
  const again = await team.teamPlan({ codexHome });
  await team.writeTeam(again, { update: true });
  assert.ok(again.files.every(f => f.state === 'igual'));
  assert.equal((await fs.readdir(path.join(codexHome, 'agents'))).length, 10);
  await fs.unlink(path.join(codexHome, 'models_cache.json'));
  assert.deepEqual(await team.installedTeam({ codexHome }), names);
});

test('updates stale levels only explicitly, backs up regular files and preserves custom profiles', async () => {
  const codexHome = await home();
  await writeLevelAgents(await levelAgentPlan({ codexHome }));
  await fs.writeFile(target(codexHome, 'custom'), 'custom untouched');
  const plan = await team.teamPlan({ codexHome });
  assert.ok(plan.files.slice(0, 4).every(f => f.state === 'distinto'));
  const previous = await fs.readFile(target(codexHome), 'utf8');
  await team.writeTeam(plan);
  assert.equal(await fs.readFile(target(codexHome), 'utf8'), previous);
  await team.writeTeam(await team.teamPlan({ codexHome }), { update: true });
  const files = await fs.readdir(path.join(codexHome, 'agents'));
  const backups = files.filter(f => f.includes('.anterior-'));
  assert.equal(backups.length, 4);
  assert.ok(backups.every(f => !f.endsWith('.toml')));
  const backup = backups.find(f => f.startsWith('nivel_normal.toml.'));
  assert.equal(await fs.readFile(path.join(codexHome, 'agents', backup), 'utf8'), previous);
  assert.equal(await fs.readFile(target(codexHome, 'custom'), 'utf8'), 'custom untouched');
  assert.ok((await team.teamPlan({ codexHome })).files.every(f => f.state === 'igual'));
});

test('missing catalog or model is honest and never writes unavailable profiles', async () => {
  const codexHome = await home(null);
  const missing = await team.teamPlan({ codexHome });
  assert.equal(missing.catalog, false);
  assert.ok(missing.files.every(f => f.state === 'sin-catalogo' && f.content === null));
  await team.writeTeam(missing, { update: true });
  await assert.rejects(fs.access(path.join(codexHome, 'agents')));
  await fs.writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({ models: catalog.slice(0, 1) }));
  const partial = await team.teamPlan({ codexHome });
  assert.equal(partial.files[4].state, 'sin-modelo');
  await team.writeTeam(partial);
  assert.deepEqual(await team.installedTeam({ codexHome }), ['nivel_ligero']);
});

test('installed detection requires matching valid native regular TOML, with bounded reads', async () => {
  const codexHome = await home(null);
  await fs.mkdir(path.join(codexHome, 'agents'));
  const native = name => `name = "${name}"\ndescription = "role"\ndeveloper_instructions = "Instructions"\n`;
  await fs.writeFile(target(codexHome, 'investigador'), native('investigador'));
  await fs.writeFile(target(codexHome, 'nivel_ligero'), native('wrong'));
  await fs.writeFile(target(codexHome, 'nivel_normal'), 'name = [');
  await fs.mkdir(target(codexHome, 'nivel_exigente'));
  await fs.writeFile(target(codexHome, 'nivel_alto'), '#'.repeat(1024 * 1024));
  await fs.writeFile(target(codexHome, 'custom'), native('custom'));
  assert.deepEqual(await team.installedTeam({ codexHome }), ['investigador']);
});

test('does not follow file links, hard links or linked agents directories', async () => {
  const codexHome = await home();
  await fs.mkdir(path.join(codexHome, 'agents'));
  const outside = path.join(codexHome, 'outside');
  await fs.writeFile(outside, 'preserved');
  await fs.symlink(outside, target(codexHome));
  await fs.link(outside, target(codexHome, 'investigador'));
  const plan = await team.teamPlan({ codexHome });
  assert.equal(plan.files[1].state, 'bloqueado');
  assert.equal(plan.files[4].state, 'bloqueado');
  await team.writeTeam(plan, { update: true });
  assert.equal((await fs.lstat(target(codexHome))).isSymbolicLink(), true);
  assert.equal(await fs.readFile(outside, 'utf8'), 'preserved');
  const linked = await home();
  await fs.symlink(path.join(codexHome, 'agents'), path.join(linked, 'agents'), 'dir');
  assert.deepEqual(await team.installedTeam({ codexHome: linked }), []);
  const linkedPlan = await team.teamPlan({ codexHome: linked });
  assert.ok(linkedPlan.files.every(f => f.state === 'bloqueado'));
  await team.writeTeam(linkedPlan, { update: true });
});

test('preflight rejects stale snapshots, new concurrent files and tampered or raw plans', async () => {
  const codexHome = await home();
  await team.writeTeam(await team.teamPlan({ codexHome }));
  await fs.writeFile(target(codexHome), 'old');
  const plan = await team.teamPlan({ codexHome });
  await fs.writeFile(target(codexHome), 'new');
  await assert.rejects(team.writeTeam(plan, { update: true }), /snapshot|cambi|concurr/iu);
  assert.equal(await fs.readFile(target(codexHome), 'utf8'), 'new');
  assert.equal((await fs.readdir(path.join(codexHome, 'agents'))).filter(f => f.includes('.anterior-')).length, 0);
  const raw = JSON.parse(JSON.stringify(await team.teamPlan({ codexHome })));
  await assert.rejects(team.writeTeam(raw, { update: true }), /plan/iu);
  const tampered = await team.teamPlan({ codexHome });
  tampered.files[1].path = path.join(codexHome, 'arbitrary');
  await assert.rejects(team.writeTeam(tampered, { update: true }), /plan|ruta/iu);
  const freshHome = await home();
  const fresh = await team.teamPlan({ codexHome: freshHome });
  await fs.mkdir(path.join(freshHome, 'agents'));
  await fs.writeFile(target(freshHome), 'raced');
  await assert.rejects(team.writeTeam(fresh), /snapshot|cambi|concurr/iu);
  assert.deepEqual(await fs.readdir(path.join(freshHome, 'agents')), ['nivel_normal.toml']);
});

test('backups preserve exact bytes and each replacement has a unique backupPath', async () => {
  const codexHome = await home();
  await team.writeTeam(await team.teamPlan({ codexHome }));
  const original = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
  const backups = [];
  for (let i = 0; i < 2; i++) {
    await fs.writeFile(target(codexHome), original);
    const result = await team.writeTeam(await team.teamPlan({ codexHome }), { update: true });
    const file = result.files[1];
    assert.equal(file.state, 'igual');
    assert.equal((await fs.lstat(file.backupPath)).isFile(), true);
    assert.deepEqual(await fs.readFile(file.backupPath), original);
    backups.push(file.backupPath);
  }
  assert.notEqual(backups[0], backups[1]);
});

test('directory replacement and concurrent publishers never overwrite an external file', async () => {
  const codexHome = await home();
  await team.writeTeam(await team.teamPlan({ codexHome }));
  await fs.writeFile(target(codexHome), 'stale');
  const stale = await team.teamPlan({ codexHome });
  await fs.rename(path.join(codexHome, 'agents'), path.join(codexHome, 'old-agents'));
  await fs.mkdir(path.join(codexHome, 'agents'));
  await fs.writeFile(target(codexHome), 'external');
  await assert.rejects(team.writeTeam(stale, { update: true }), /snapshot|cambi|concurr/iu);
  assert.equal(await fs.readFile(target(codexHome), 'utf8'), 'external');
  const freshHome = await home();
  const first = await team.teamPlan({ codexHome: freshHome });
  const second = await team.teamPlan({ codexHome: freshHome });
  const results = await Promise.allSettled([team.writeTeam(first), team.writeTeam(second)]);
  assert.ok(results.some(result => result.status === 'rejected'));
  assert.deepEqual(await team.installedTeam({ codexHome: freshHome }), names);
  assert.equal((await fs.readdir(path.join(freshHome, 'agents'))).length, 10);
});

test('exclusive update keeps a file arriving between backup and publication', async t => {
  const codexHome = await home();
  await team.writeTeam(await team.teamPlan({ codexHome }));
  await fs.writeFile(target(codexHome), 'original');
  const plan = await team.teamPlan({ codexHome });
  const rename = fs.rename.bind(fs);
  const patch = t.mock.method(fs, 'rename', async (source, destination) => {
    await rename(source, destination);
    if (source === target(codexHome)) await fs.writeFile(source, 'concurrent external file', { flag: 'wx' });
  });
  try {
    await assert.rejects(team.writeTeam(plan, { update: true }), /concurrent/iu);
    assert.equal(await fs.readFile(target(codexHome), 'utf8'), 'concurrent external file');
    const backups = (await fs.readdir(path.join(codexHome, 'agents'))).filter(f => f.startsWith('nivel_normal.toml.anterior-'));
    assert.equal(backups.length, 1);
    assert.equal(await fs.readFile(path.join(codexHome, 'agents', backups[0]), 'utf8'), 'original');
  } finally { patch.mock.restore(); }
});

test('publication EIO restores exact original bytes and keeps partial plan snapshots reusable', async t => {
  const codexHome = await home();
  await team.writeTeam(await team.teamPlan({ codexHome }));
  await fs.writeFile(target(codexHome, 'nivel_ligero'), 'stale first profile');
  const original = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
  await fs.writeFile(target(codexHome), original);
  const plan = await team.teamPlan({ codexHome });
  const link = fs.link.bind(fs);
  const failure = Object.assign(new Error('publication failed'), { code: 'EIO' });
  const patch = t.mock.method(fs, 'link', async (source, destination) => {
    if (source.endsWith('.tmp') && destination === target(codexHome)) throw failure;
    return link(source, destination);
  });
  try {
    await assert.rejects(team.writeTeam(plan, { update: true }), error => error === failure);
  } finally { patch.mock.restore(); }
  assert.deepEqual(await fs.readFile(target(codexHome)), original);
  assert.equal((await fs.lstat(target(codexHome))).nlink, 1);
  assert.equal(plan.files[0].state, 'igual');
  assert.equal(plan.files[1].state, 'distinto');
  assert.deepEqual(await fs.readFile(plan.files[1].backupPath), original);
  const fresh = await team.teamPlan({ codexHome });
  assert.deepEqual(plan.files.map(file => file.snapshot), fresh.files.map(file => file.snapshot));
  assert.equal((await fs.readdir(path.join(codexHome, 'agents'))).length, names.length + 2);
  await team.writeTeam(plan, { update: true });
  assert.ok((await team.teamPlan({ codexHome })).files.every(file => file.state === 'igual'));
});

test('publication failure and rollback preserve concurrent regular files, links and directories', async t => {
  for (const kind of ['file', 'symlink', 'hardlink', 'directory', 'rollback-race']) {
    await t.test(kind, async t => {
      const codexHome = await home();
      await team.writeTeam(await team.teamPlan({ codexHome }));
      const original = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
      await fs.writeFile(target(codexHome), original);
      const outside = path.join(codexHome, 'outside');
      await fs.writeFile(outside, 'external bytes');
      const plan = await team.teamPlan({ codexHome });
      const link = fs.link.bind(fs);
      const failure = Object.assign(new Error('publication failed'), { code: 'EIO' });
      const createConcurrent = async () => {
        if (kind === 'symlink') await fs.symlink(outside, target(codexHome));
        else if (kind === 'hardlink') await link(outside, target(codexHome));
        else if (kind === 'directory') await fs.mkdir(target(codexHome));
        else await fs.writeFile(target(codexHome), 'concurrent bytes', { flag: 'wx' });
      };
      const patch = t.mock.method(fs, 'link', async (source, destination) => {
        if (destination === target(codexHome)) {
          if (source.endsWith('.tmp')) {
            if (kind !== 'rollback-race') await createConcurrent();
            throw failure;
          }
          if (kind === 'rollback-race') await createConcurrent();
        }
        return link(source, destination);
      });
      try {
        await assert.rejects(team.writeTeam(plan, { update: true }), error => error === failure);
      } finally { patch.mock.restore(); }
      const stat = await fs.lstat(target(codexHome));
      if (kind === 'directory') assert.equal(stat.isDirectory(), true);
      else if (kind === 'symlink') assert.equal(await fs.readlink(target(codexHome)), outside);
      else if (kind === 'hardlink') assert.equal(stat.ino, (await fs.lstat(outside)).ino);
      else assert.equal(await fs.readFile(target(codexHome), 'utf8'), 'concurrent bytes');
      assert.equal(await fs.readFile(outside, 'utf8'), 'external bytes');
      const backups = (await fs.readdir(path.join(codexHome, 'agents'))).filter(file => file.includes('.anterior-'));
      assert.equal(backups.length, 1);
      assert.deepEqual(await fs.readFile(path.join(codexHome, 'agents', backups[0])), original);
      await assert.rejects(team.writeTeam(plan, { update: true }), /snapshot|concurr/iu);
      const fresh = await team.teamPlan({ codexHome });
      assert.equal(fresh.files[1].state, ['file', 'rollback-race'].includes(kind) ? 'distinto' : 'bloqueado');
      await team.writeTeam(fresh, { update: true });
    });
  }
});

test('home resolution honors explicit home, supplied environment and homeDirectory fallback', async () => {
  const explicit = await home();
  const environment = await home();
  assert.equal((await team.teamPlan({ codexHome: explicit, environment: { CODEX_HOME: environment } })).codexHome, explicit);
  assert.equal((await team.teamPlan({ codexHome: null, environment: { CODEX_HOME: environment } })).codexHome, environment);
  if (!process.env.CODEX_HOME) {
    const homeDirectory = await home(null);
    const fallback = await team.teamPlan({ environment: {}, homeDirectory });
    assert.equal(fallback.codexHome, path.join(homeDirectory, '.codex'));
    await assert.rejects(fs.access(fallback.codexHome));
  }
});
