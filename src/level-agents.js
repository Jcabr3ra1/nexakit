import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentModels } from "./agent-models.js";

// Codex has no plugins, so its level agents are files. Claude's come from the `niveles` plugin.
// The top level is "alto"; xhigh is asked per spawn, only after high failed.
const LEVELS = [["Ligero", "ligero"], ["Normal", "normal"], ["Exigente", "exigente"], ["Alto", "alto"]];
const USES = { ligero: "comandos, búsquedas, lecturas y cambios mecánicos", normal: "implementar con un diseño claro", exigente: "pruebas, casos borde o un fallo acotado", alto: "un fallo sutil, seguridad o lo que exigente no resolvió" };
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;

export class LevelAgentsError extends Error {
  constructor(message) { super(message); this.code = "level-agents"; }
}

function content(slug, level, { model, effort }) {
  const task = `nivel ${level} (${model}, ${effort})`;
  return [`# Generado por \`agent-toolkit-inbox agentes\`. Ese comando nunca sobrescribe ni borra: lo anterior queda como .anterior-*.`,
    `name = ${JSON.stringify(`nivel_${slug}`)}`,
    `description = ${JSON.stringify(`Ejecuta una tarea delegada de ${task}. Úsalo para ${USES[slug]}.`)}`,
    `model = ${JSON.stringify(model)}`, `model_reasoning_effort = ${JSON.stringify(effort)}`,
    `developer_instructions = """`,
    `Ejecutas una tarea que te delega la sesión principal, con el ${task}.`,
    "Haz solo lo que pide la delegación y respeta las reglas del proyecto (AGENTS.md y sus skills).",
    "Si la tarea es de código: cambio mínimo, pruebas que lo cubran, y ejecútalas junto con el lint o la compilación que correspondan.",
    "No hagas commit, push ni PR, y no envíes, apruebes ni reclames encargos de revisión.",
    "Termina con los cambios por archivo, las comprobaciones ejecutadas con su resultado real y lo que no comprobaste.",
    `"""`, ""].join("\n");
}

async function current(file) {
  try {
    const stat = await fs.lstat(file);
    // A link or a directory is never read through or replaced silently: it counts as different.
    return stat.isFile() ? await fs.readFile(file, "utf8") : false;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Plans the Codex level agents from the live catalog; writes nothing.
export async function levelAgentPlan({ codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex") } = {}) {
  const { codex, levels } = await agentModels({ codexHome });
  const files = [];
  for (const [level, slug] of LEVELS) {
    const target = path.join(codexHome, "agents", `nivel_${slug}.toml`);
    const pick = levels.find(entry => entry.level === level)?.codex;
    const base = { level: slug, name: `nivel_${slug}`, path: target, model: pick?.model ?? null, effort: pick?.effort ?? null };
    if (!codex.available) { files.push({ ...base, state: "sin-catalogo" }); continue; }
    if (!pick || !MODEL.test(pick.model)) { files.push({ ...base, state: "sin-modelo" }); continue; }
    const wanted = content(slug, level, pick);
    const existing = await current(target);
    files.push({ ...base, content: wanted, state: existing === null ? "nuevo" : existing === wanted ? "igual" : "distinto" });
  }
  return { catalog: codex.available, files };
}

async function directory(dir) {
  await fs.mkdir(dir, { recursive: true });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory()) throw new LevelAgentsError(`${dir} debe ser un directorio y no un enlace; no se escribió nada en él.`);
}

// Publishing with link() fails instead of replacing whatever appeared at the target.
async function publish(file) {
  const temporary = path.join(path.dirname(file.path), `.nivel-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, file.content, { flag: "wx", mode: 0o644 });
    await fs.link(temporary, file.path);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

// Never overwrites or deletes: a different file is kept under a unique `.anterior-*` name, and only with `force`.
export async function writeLevelAgents(plan, { force = false } = {}) {
  for (const file of plan.files) {
    if (file.state !== "nuevo" && !(force && file.state === "distinto")) continue;
    await directory(path.dirname(file.path));
    if (file.state === "distinto") {
      file.anterior = `${file.path}.anterior-${new Date().toISOString().replace(/\D/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
      try { await fs.rename(file.path, file.anterior); }
      catch (error) { if (error.code !== "ENOENT") throw error; file.anterior = null; }
    }
    if (await publish(file)) file.state = file.state === "nuevo" ? "escrito" : "actualizado";
    else file.state = "distinto";
  }
  return plan;
}

const LABEL = { nuevo: "se crea", escrito: "creado", igual: "sin cambios", distinto: "ya existe y es distinto: no se toca",
  actualizado: "actualizado", "sin-modelo": "sin modelo de esa categoría", "sin-catalogo": "catálogo no disponible" };

export function levelAgentsTable({ catalog, files }) {
  const lines = ["**Agentes por nivel de Codex**", "", "| Nivel | Nombre | Modelo | Esfuerzo | Estado |", "| --- | --- | --- | --- | --- |"];
  for (const file of files) {
    lines.push(`| ${file.level} | \`${file.name}\` | ${file.model ? `\`${file.model}\`` : "—"} | ${file.effort ? `\`${file.effort}\`` : "—"} | ${LABEL[file.state]} |`);
  }
  lines.push("");
  if (!catalog) lines.push("No se pudo leer el catálogo de Codex (`models_cache.json`); no se escribe nada hasta que se lea bien.");
  const pending = files.filter(file => file.state === "nuevo").length, different = files.filter(file => file.state === "distinto").length;
  if (pending) lines.push(`Vista previa: no se escribió nada. Ejecuta \`agent-toolkit-inbox agentes --escribir\` para crear ${pending}.`);
  if (different) lines.push(`Hay ${different} ${different === 1 ? "archivo" : "archivos"} con otro contenido que no se ${different === 1 ? "toca" : "tocan"}. Con \`--escribir --forzar\` se actualizan y el anterior queda como \`.anterior-*\` junto al archivo.`);
  for (const file of files.filter(item => item.anterior)) lines.push(`Anterior conservado: \`${file.anterior}\`.`);
  if (!pending && !different && catalog) lines.push("Los agentes están al día.");
  lines.push("");
  return lines.join("\n");
}
