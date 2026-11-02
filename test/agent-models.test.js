import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { agentModels, agentModelsTable } from "../src/agent-models.js";
import { runPeerInboxCli } from "../src/peer-inbox-cli.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-models-"));
after(() => fs.rm(root, { recursive: true, force: true }));
const levels = efforts => efforts.map(effort => ({ effort }));

async function codexHome(models, config) {
  const dir = await fs.mkdtemp(path.join(root, "codex-"));
  if (models) await fs.writeFile(path.join(dir, "models_cache.json"), JSON.stringify({ fetched_at: "2026-10-26", models }));
  if (config) await fs.writeFile(path.join(dir, "config.toml"), config);
  return dir;
}

test("levels use the newest Codex model of each category and skip older or hidden ones", async () => {
  const dir = await codexHome([
    { slug: "nuevo-diario", description: "Latest workhorse model for coding", priority: 1, supported_reasoning_levels: levels(["low", "medium", "high", "xhigh", "max"]) },
    { slug: "viejo-diario", description: "Previous generation workhorse model.", priority: 0, supported_reasoning_levels: levels(["low", "medium", "high"]) },
    { slug: "frontera", description: "Frontier intelligence for the most demanding work.", priority: 2, supported_reasoning_levels: levels(["low", "high", "xhigh"]) },
    { slug: "rapido", description: "Fast and affordable model for easier tasks.", priority: 5, supported_reasoning_levels: levels(["low", "medium"]) },
    { slug: "oculto", description: "Fast and affordable", visibility: "hide", priority: 0, supported_reasoning_levels: levels(["low"]) }
  ], 'model = "nuevo-diario"\nmodel_reasoning_effort = "high"\n[mcp_servers.x]\nmodel = "otro"\n');
  const result = await agentModels({ codexHome: dir });
  assert.deepEqual(result.levels.map(level => level.codex && `${level.codex.model}:${level.codex.effort}`),
    ["rapido:low", "nuevo-diario:medium", "nuevo-diario:high", "frontera:high"]);
  assert.equal(result.codex.models.some(model => model.model === "oculto"), false);
  assert.equal(result.codex.models.find(model => model.model === "viejo-diario").category, "anterior");
  assert.deepEqual(result.codexCurrent, { model: "nuevo-diario", effort: "high" });
  const table = agentModelsTable(result);
  assert.match(table, /\| Exigente \| 5–6 \| `sonnet`, `high` \| `nuevo-diario`, `high` \|/u);
  assert.match(table, /Codex usa ahora: `nuevo-diario`, `high`/u);
});

test("a missing catalog or unsupported effort is reported instead of inventing a model", async () => {
  const empty = await agentModels({ codexHome: await codexHome(null, null) });
  assert.equal(empty.codex.available, false);
  assert.equal(empty.levels.every(level => level.codex === null), true);
  assert.match(agentModelsTable(empty), /No se encontró `models_cache.json`/u);
  assert.match(agentModelsTable(empty), /No se pudo leer la configuración actual de Codex/u);
  const limited = await agentModels({ codexHome: await codexHome([
    { slug: "frontera", description: "Frontier intelligence", supported_reasoning_levels: levels(["low", "medium"]) }]) });
  assert.equal(limited.levels.find(level => level.level === "Alto").codex, null);
});

test("a newer model without the effort does not hide an older one that supports it", async () => {
  const result = await agentModels({ codexHome: await codexHome([
    { slug: "nuevo", description: "Latest workhorse model", priority: 0, supported_reasoning_levels: levels(["low", "medium"]) },
    { slug: "anterior-util", description: "Everyday workhorse model", priority: 1, supported_reasoning_levels: levels(["low", "medium", "high"]) }]) });
  assert.deepEqual(result.levels.map(level => level.codex && `${level.codex.model}:${level.codex.effort}`),
    [null, "nuevo:medium", "anterior-util:high", null]);
});

test("the Codex profile selected at the top level overrides the model and effort", async () => {
  const current = async config => (await agentModels({ codexHome: await codexHome(null, config) })).codexCurrent;
  const profile = 'profile = "trabajo"\nmodel = "base"\nmodel_reasoning_effort = "low"\n[profiles.otro]\nmodel = "otro"\n[profiles.trabajo]\nmodel = "elegido"\n[profiles.trabajo.extra]\nmodel = "no"\n';
  assert.deepEqual(await current(profile), { model: "elegido", effort: "low" });
  assert.deepEqual(await current('profile = "trabajo"\n[profiles.trabajo]\nmodel_reasoning_effort = "xhigh"\nmodel = "m"\n'), { model: "m", effort: "xhigh" });
  assert.deepEqual(await current('profile = "ausente"\nmodel = "base"\n'), { model: "base", effort: null });
  assert.deepEqual(await current("model = 'comillas-simples'\n"), { model: "comillas-simples", effort: null });
  assert.equal(await current("model = \n"), null);
  assert.deepEqual(await current('model = "base"\n[profiles.undefined]\nmodel = "no-seleccionado"\n'), { model: "base", effort: null });
  assert.deepEqual(await current('profile = 1\nmodel = "base"\n[profiles."1"]\nmodel = "no-seleccionado"\n'), { model: "base", effort: null });
});

test("Codex profile headers are matched by their decoded key segments", async () => {
  const current = async config => (await agentModels({ codexHome: await codexHome(null, config) })).codexCurrent;
  const spaced = 'profile = "trabajo"\nmodel = "base"\n[ profiles . "trabajo" ] # perfil\nmodel = "elegido"\n';
  assert.deepEqual(await current(spaced), { model: "elegido", effort: null });
  assert.deepEqual(await current('profile = "trabajo"\n["profiles"."trabajo"]\nmodel = "elegido"\n'), { model: "elegido", effort: null });
  const dotted = ['[profiles.trabajo.extra]\nmodel = "no-es-el-perfil"\n', '[profiles."trabajo.extra"]\nmodel = "elegido"\n'];
  for (const tables of [dotted, [...dotted].reverse()]) {
    assert.deepEqual(await current('profile = "trabajo.extra"\nmodel = "base"\n' + tables.join("")), { model: "elegido", effort: null });
  }
});

test("the saved Claude model and effort are read from settings.json or reported as unreadable", async () => {
  const dir = await fs.mkdtemp(path.join(root, "claude-"));
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ model: "sonnet", effortLevel: "high", env: { X: "1" } }));
  const result = await agentModels({ codexHome: await codexHome(null, null), claudeHome: dir });
  assert.deepEqual(result.claudeCurrent, { model: "sonnet", effort: "high" });
  assert.match(agentModelsTable(result), /Claude tiene guardado: `sonnet`, `high`/u);
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ model: "opus" }));
  assert.match(agentModelsTable(await agentModels({ codexHome: await codexHome(null, null), claudeHome: dir })), /`opus`, `sin esfuerzo fijado`/u);
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ effortLevel: "high" }));
  assert.match(agentModelsTable(await agentModels({ codexHome: await codexHome(null, null), claudeHome: dir })), /`sin modelo fijado`, `high`/u);
  await fs.writeFile(path.join(dir, "settings.json"), JSON.stringify({ model: 5, effortLevel: ["high"] }));
  assert.deepEqual((await agentModels({ codexHome: await codexHome(null, null), claudeHome: dir })).claudeCurrent, { model: null, effort: null });
  for (const content of ["{roto", "[]", null]) {
    if (content === null) await fs.rm(path.join(dir, "settings.json"));
    else await fs.writeFile(path.join(dir, "settings.json"), content);
    const unreadable = await agentModels({ codexHome: await codexHome(null, null), claudeHome: dir });
    assert.match(agentModelsTable(unreadable), /No se pudo leer la configuración guardada de Claude/u);
  }
});

test("the inbox CLI prints the catalog as a table or JSON", async () => {
  const dir = await codexHome([{ slug: "diario", description: "Latest workhorse model", supported_reasoning_levels: levels(["low", "medium", "high"]) }]);
  const out = [], json = [], errors = [];
  assert.equal(await runPeerInboxCli(["modelos"], { codexHome: dir, out: t => out.push(t), err: () => {} }), 0);
  assert.match(out.join(""), /\*\*Niveles con los modelos actuales\*\*/u);
  assert.equal(await runPeerInboxCli(["modelos", "--json"], { codexHome: dir, out: t => json.push(t), err: () => {} }), 0);
  assert.equal(JSON.parse(json.join("")).levels[1].codex.model, "diario");
  assert.equal(await runPeerInboxCli(["modelos", "--otro"], { codexHome: dir, out: () => {}, err: t => errors.push(t) }), 2);
  assert.match(errors.join(""), /agent-toolkit-inbox modelos/u);
});

test("new models without useful description inherit the role of their family or are marked sin clasificar", async () => {
  const dir = await codexHome([
    { slug: "gpt-9-terra", description: "GPT-9 Terra Codex model.", priority: 0, supported_reasoning_levels: levels(["low", "medium", "high"]) },
    { slug: "gpt-5.6-terra", description: "Older balanced model for straightforward work.", priority: 5, supported_reasoning_levels: levels(["low", "medium", "high"]) },
    { slug: "gpt-9-luna", description: "GPT-9 Luna model.", priority: 1, supported_reasoning_levels: levels(["low", "medium"]) },
    { slug: "gpt-9-cometa", description: "GPT-9 Cometa model.", priority: 2, supported_reasoning_levels: levels(["low", "high"]) },
    { slug: "gpt-8-cometa", description: "Previous generation frontier intelligence.", priority: 6, supported_reasoning_levels: levels(["low", "high"]) },
    { slug: "gpt-9-quasar", description: "GPT-9 Quasar model.", priority: 3, supported_reasoning_levels: levels(["low", "medium"]) }
  ]);
  const result = await agentModels({ codexHome: dir });
  const bySlug = Object.fromEntries(result.codex.models.map(item => [item.model, item.category]));
  assert.equal(bySlug["gpt-9-terra"], "uso diario");
  assert.equal(bySlug["gpt-5.6-terra"], "anterior");
  assert.equal(bySlug["gpt-9-luna"], "ligero");
  assert.equal(bySlug["gpt-9-cometa"], "el más capaz");
  assert.equal(bySlug["gpt-8-cometa"], "anterior");
  assert.equal(bySlug["gpt-9-quasar"], "sin clasificar");
  assert.deepEqual(
    result.levels.map(level => level.codex && `${level.codex.model}:${level.codex.effort}`),
    ["gpt-9-luna:low", "gpt-9-terra:medium", "gpt-9-terra:high", "gpt-9-cometa:high"]
  );
});
