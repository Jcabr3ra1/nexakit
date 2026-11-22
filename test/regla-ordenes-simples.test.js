import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { renderAntigravityAgents } from '../src/antigravity-agents.js';
import { teamPlan } from '../src/codex-team.js';
import { levelAgentPlan } from '../src/level-agents.js';
import { REGLA_ORDENES_SIMPLES } from '../src/regla-ordenes-simples.js';

// Los subagentes con Bash o shell reciben una orden por llamada: Claude Code no analiza `cd` encadenado, `;` ni subshells.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'regla-ordenes-'));
after(() => fs.rm(root, { recursive: true, force: true }));
const models = ['Fast and affordable model', 'Latest workhorse model', 'Frontier intelligence'].map((description, i) => ({
  slug: ['rapido', 'diario', 'frontera'][i], description,
  supported_reasoning_levels: ['low', 'medium', 'high'].map(effort => ({ effort }))
}));

async function codexHome() {
  const dir = await fs.mkdtemp(path.join(root, 'home-'));
  await fs.writeFile(path.join(dir, 'models_cache.json'), JSON.stringify({ models }));
  return dir;
}

test('la regla dice lo esencial', () => {
  for (const parte of ['Una orden por llamada', 'rutas absolutas', '`cd`', '`;`', '`&&`', '`||`', 'subshells', '`head`', 'en paralelo']) {
    assert.ok(REGLA_ORDENES_SIMPLES.includes(parte), parte);
  }
});

test('los diez agentes de niveles (Claude) llevan la regla', async () => {
  const dir = new URL('../plugins/niveles/agents/', import.meta.url);
  const archivos = (await fs.readdir(dir)).filter(nombre => nombre.endsWith('.md'));
  assert.equal(archivos.length, 10);
  for (const nombre of archivos) {
    assert.ok((await fs.readFile(new URL(nombre, dir), 'utf8')).includes(REGLA_ORDENES_SIMPLES), nombre);
  }
});

test('los diez subagentes de Antigravity llevan la regla', async () => {
  const agentes = await renderAntigravityAgents();
  assert.equal(agentes.length, 10);
  for (const agente of agentes) assert.ok(agente.content.includes(REGLA_ORDENES_SIMPLES), agente.name);
});

test('los cuatro niveles y los seis especialistas de Codex llevan la regla', async () => {
  const home = await codexHome();
  const niveles = await levelAgentPlan({ codexHome: home });
  assert.equal(niveles.files.length, 4);
  for (const archivo of niveles.files) {
    assert.ok(getStaticTOMLValue(parseTOML(archivo.content)).developer_instructions.includes(REGLA_ORDENES_SIMPLES), archivo.name);
  }
  const equipo = await teamPlan({ codexHome: home });
  assert.equal(equipo.files.length, 10);
  for (const archivo of equipo.files) {
    assert.ok(getStaticTOMLValue(parseTOML(archivo.content)).developer_instructions.includes(REGLA_ORDENES_SIMPLES), archivo.name);
  }
});
