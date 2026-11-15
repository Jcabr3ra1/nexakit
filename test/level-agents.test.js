import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { levelAgentPlan, levelAgentsTable, writeLevelAgents } from "../src/level-agents.js";
import { runPeerInboxCli } from "../src/peer-inbox-cli.js";
import { fileSymlinkSkipReason } from "../testing/symlink-capability.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "level-agents-"));
after(() => fs.rm(root, { recursive: true, force: true }));
const levels = efforts => efforts.map(effort => ({ effort }));
const CATALOG = [
  { slug: "rapido", description: "Fast and affordable model", priority: 0, supported_reasoning_levels: levels(["low", "medium"]) },
  { slug: "diario", description: "Latest workhorse model", priority: 1, supported_reasoning_levels: levels(["low", "medium", "high"]) },
  { slug: "frontera", description: "Frontier intelligence", priority: 2, supported_reasoning_levels: levels(["low", "high", "xhigh"]) }
];

async function home(catalog = CATALOG) {
  const dir = await fs.mkdtemp(path.join(root, "case-"));
  if (catalog) await fs.writeFile(path.join(dir, "models_cache.json"), JSON.stringify({ models: catalog }));
  return dir;
}
const agent = (codexHome, slug) => path.join(codexHome, "agents", `nivel_${slug}.toml`);
const states = plan => Object.fromEntries(plan.files.map(file => [file.level, file.state]));

test("the plan covers four Codex levels from the live catalog and writes nothing", async () => {
  const codexHome = await home();
  const plan = await levelAgentPlan({ codexHome });
  assert.deepEqual(plan.files.map(file => [file.level, file.model, file.effort]),
    [["ligero", "rapido", "low"], ["normal", "diario", "medium"], ["exigente", "diario", "high"], ["alto", "frontera", "high"]]);
  assert.equal(Object.values(states(plan)).every(state => state === "nuevo"), true);
  assert.match(plan.files[2].content, /^name = "nivel_exigente"\ndescription = ".*"\nmodel = "diario"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = """\n/mu);
  await assert.rejects(fs.access(path.join(codexHome, "agents")));
  assert.match(levelAgentsTable(plan), /Vista previa: no se escribió nada.*crear 4/u);
});

test("generated files carry the nexakit mark, not the retired inbox one", async () => {
  const plan = await levelAgentPlan({ codexHome: await home() });
  for (const file of plan.files) {
    assert.ok(file.content.startsWith("# Generado por `nexakit codex agentes`. "));
    assert.doesNotMatch(file.content, /agent-toolkit-inbox/u);
  }
  assert.match(levelAgentsTable(plan), /nexakit codex agentes --apply/u);
  assert.doesNotMatch(levelAgentsTable(plan), /agent-toolkit-inbox/u);
});

test("generated files are valid TOML with every field Codex requires", async () => {
  const plan = await levelAgentPlan({ codexHome: await home() });
  for (const file of plan.files) {
    const parsed = getStaticTOMLValue(parseTOML(file.content));
    assert.deepEqual(Object.keys(parsed).sort(), ["description", "developer_instructions", "model", "model_reasoning_effort", "name"]);
    assert.deepEqual([parsed.name, parsed.model, parsed.model_reasoning_effort], [file.name, file.model, file.effort]);
    assert.match(parsed.developer_instructions, /no hagas commit, push ni PR/iu);
  }
});

test("writing creates missing agents once and is idempotent", async () => {
  const codexHome = await home();
  await writeLevelAgents(await levelAgentPlan({ codexHome }));
  assert.match(await fs.readFile(agent(codexHome, "normal"), "utf8"), /^model = "diario"$/mu);
  const again = await levelAgentPlan({ codexHome });
  assert.equal(Object.values(states(again)).every(state => state === "igual"), true);
  assert.match(levelAgentsTable(again), /Los agentes están al día/u);
  assert.equal((await fs.readdir(path.join(codexHome, "agents"))).length, 4);
});

test("a different file is never touched without force, and force keeps it as .anterior-*", async () => {
  const codexHome = await home();
  await fs.mkdir(path.join(codexHome, "agents"));
  await fs.writeFile(agent(codexHome, "normal"), "# mío, con la marca copiada: Generado por agent-toolkit-inbox agentes\n");
  const plan = await levelAgentPlan({ codexHome });
  assert.equal(states(plan).normal, "distinto");
  await writeLevelAgents(plan);
  assert.match(await fs.readFile(agent(codexHome, "normal"), "utf8"), /^# mío/u);
  assert.equal(states(plan).normal, "distinto");
  assert.match(levelAgentsTable(plan), /Hay 1 archivo con otro contenido que no se toca/u);

  const forced = await levelAgentPlan({ codexHome });
  await writeLevelAgents(forced, { force: true });
  assert.match(await fs.readFile(agent(codexHome, "normal"), "utf8"), /^model = "diario"$/mu);
  assert.equal(forced.files[1].state, "actualizado");
  assert.match(await fs.readFile(forced.files[1].anterior, "utf8"), /^# mío/u);
  assert.match(path.basename(forced.files[1].anterior), /^nivel_normal\.toml\.anterior-\d{14}-[0-9a-f]{8}$/u);
  assert.match(levelAgentsTable(forced), /Anterior conservado/u);
});

test("force repeated keeps every previous version", async () => {
  const codexHome = await home();
  await fs.mkdir(path.join(codexHome, "agents"));
  for (const text of ["uno\n", "dos\n"]) {
    await fs.writeFile(agent(codexHome, "ligero"), text);
    await writeLevelAgents(await levelAgentPlan({ codexHome }), { force: true });
  }
  const kept = (await fs.readdir(path.join(codexHome, "agents"))).filter(name => name.includes(".anterior-"));
  assert.equal(kept.length, 2);
  assert.deepEqual((await Promise.all(kept.map(name => fs.readFile(path.join(codexHome, "agents", name), "utf8")))).sort(), ["dos\n", "uno\n"]);
});

test("a file that appears after planning or a directory in its place are kept", async () => {
  const codexHome = await home();
  const plan = await levelAgentPlan({ codexHome });
  await fs.mkdir(path.join(codexHome, "agents"));
  await fs.writeFile(agent(codexHome, "ligero"), "apareció a la vez\n");
  await fs.mkdir(agent(codexHome, "exigente"));
  await fs.writeFile(path.join(agent(codexHome, "exigente"), "dentro"), "x");
  await writeLevelAgents(plan);
  assert.equal(await fs.readFile(agent(codexHome, "ligero"), "utf8"), "apareció a la vez\n");
  assert.equal(plan.files[0].state, "distinto");
  assert.equal(await fs.readFile(path.join(agent(codexHome, "exigente"), "dentro"), "utf8"), "x");
  assert.equal(states(await levelAgentPlan({ codexHome })).exigente, "distinto");

  // With force, the directory moves aside whole; nothing is followed or removed.
  const forced = await levelAgentPlan({ codexHome });
  await writeLevelAgents(forced, { force: true });
  assert.equal(await fs.readFile(path.join(forced.files[2].anterior, "dentro"), "utf8"), "x");
});

test("file links are preserved and force moves only the link", {
  skip: fileSymlinkSkipReason()
}, async () => {
  const codexHome = await home();
  await fs.mkdir(path.join(codexHome, "agents"));
  const source = path.join(codexHome, "destino.toml");
  await fs.writeFile(source, "intacto\n");
  await fs.symlink(source, agent(codexHome, "normal"));
  const plan = await levelAgentPlan({ codexHome });
  await writeLevelAgents(plan);
  assert.equal(states(plan).normal, "distinto");
  assert.equal((await fs.lstat(agent(codexHome, "normal"))).isSymbolicLink(), true);
  const forced = await levelAgentPlan({ codexHome });
  await writeLevelAgents(forced, { force: true });
  assert.equal((await fs.lstat(forced.files[1].anterior)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(source, "utf8"), "intacto\n");
});

test("a linked agents directory stops writing", async () => {
  const codexHome = await home();
  const elsewhere = path.join(codexHome, "otro");
  await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, path.join(codexHome, "agents"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(writeLevelAgents(await levelAgentPlan({ codexHome })), { code: "level-agents", message: /no un enlace/u });
  assert.deepEqual(await fs.readdir(elsewhere), []);
});

test("an unreadable catalog or a level without model writes nothing", async () => {
  const codexHome = await home();
  await writeLevelAgents(await levelAgentPlan({ codexHome }));
  for (const broken of ["{roto", null]) {
    if (broken === null) await fs.rm(path.join(codexHome, "models_cache.json"));
    else await fs.writeFile(path.join(codexHome, "models_cache.json"), broken);
    const plan = await levelAgentPlan({ codexHome });
    assert.equal(plan.catalog, false);
    assert.equal(plan.files.every(file => file.state === "sin-catalogo"), true);
    await writeLevelAgents(plan, { force: true });
    assert.equal((await fs.readdir(path.join(codexHome, "agents"))).length, 4);
    assert.match(levelAgentsTable(plan), /No se pudo leer el catálogo de Codex/u);
  }
  await fs.writeFile(path.join(codexHome, "models_cache.json"), JSON.stringify({ models: CATALOG.slice(0, 2) }));
  const plan = await levelAgentPlan({ codexHome });
  assert.equal(states(plan).alto, "sin-modelo");
  await writeLevelAgents(plan, { force: true });
  assert.equal((await fs.readdir(path.join(codexHome, "agents"))).filter(name => name === "nivel_alto.toml").length, 1);
});

test("the inbox CLI previews, writes, forces and rejects bad flags", async () => {
  const codexHome = await home();
  const run = async argv => {
    const out = [], errors = [];
    const code = await runPeerInboxCli(argv, { codexHome, out: t => out.push(t), err: t => errors.push(t) });
    return { code, out: out.join(""), errors: errors.join("") };
  };
  const preview = await run(["agentes", "--json"]);
  assert.equal(preview.code, 0);
  assert.equal(JSON.parse(preview.out).files.some(file => "content" in file), false);
  await assert.rejects(fs.access(path.join(codexHome, "agents")));
  assert.match((await run(["agentes", "--escribir"])).out, /creado/u);
  assert.equal((await fs.readdir(path.join(codexHome, "agents"))).length, 4);
  assert.match((await run(["agentes"])).out, /Los agentes están al día/u);
  await fs.writeFile(agent(codexHome, "normal"), "otro\n");
  assert.match((await run(["agentes", "--escribir"])).out, /ya existe y es distinto/u);
  assert.equal(await fs.readFile(agent(codexHome, "normal"), "utf8"), "otro\n");
  assert.match((await run(["agentes", "--escribir", "--forzar"])).out, /actualizado/u);
  for (const argv of [["agentes", "--otro"], ["agentes", "--json", "--json"], ["agentes", "--forzar"]]) {
    const result = await run(argv);
    assert.equal(result.code, 2);
    assert.match(result.errors, /agent-toolkit-inbox agentes/u);
  }
});
