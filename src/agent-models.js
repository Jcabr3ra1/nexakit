import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";

// Claude Code accepts stable aliases; Codex publishes its catalog in models_cache.json.
const CLAUDE = [
  { model: "haiku", category: "ligero", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { model: "sonnet", category: "uso diario", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { model: "opus", category: "el más capaz", efforts: ["low", "medium", "high", "xhigh", "max"] }
];
const LEVELS = [
  { level: "Ligero", total: "0–2", category: "ligero", effort: "low" },
  { level: "Normal", total: "3–4", category: "uso diario", effort: "medium" },
  { level: "Exigente", total: "5–6", category: "uso diario", effort: "high" },
  { level: "Alto", total: "7–10", category: "el más capaz", effort: "high" }
];
const FAMILY_ROLES = Object.freeze({
  luna: "ligero",
  flash: "ligero",
  haiku: "ligero",
  terra: "uso diario",
  sol: "uso diario",
  sonnet: "uso diario",
  astra: "el más capaz",
  argon: "el más capaz",
  opus: "el más capaz"
});

export function roleFromDescription(description = "") {
  if (/\b(fast and (affordable|efficient)|easier tasks|lightweight)\b/iu.test(description)) return "ligero";
  if (/\b(frontier|most demanding)\b/iu.test(description)) return "el más capaz";
  if (/\b(workhorse|everyday|balanced|straightforward work)\b/iu.test(description)) return "uso diario";
  return null;
}

export function familyOfModel(slug = "") {
  const base = String(slug).replace(/-(?:low|medium|high|xhigh|max|ultra)$/iu, "");
  const known = base.match(/\b(luna|terra|sol|astra|flash|argon|haiku|sonnet|opus)\b/iu);
  if (known) return known[1].toLowerCase();
  const family = base.match(/^(?:gpt|gemini|claude)-\d+(?:\.\d+)*-([a-z][a-z0-9]*)$/iu);
  return family ? family[1].toLowerCase() : null;
}

export function classifyModelRole(slug = "", description = "", familyRoles = new Map(Object.entries(FAMILY_ROLES))) {
  if (/\b(older|previous)\b/iu.test(description)) return "anterior";
  const direct = roleFromDescription(description);
  if (direct) return direct;
  const family = familyOfModel(slug);
  if (family && familyRoles.has(family)) return familyRoles.get(family);
  return "sin clasificar";
}

export function buildFamilyRoleMap(items = []) {
  const map = new Map(Object.entries(FAMILY_ROLES));
  for (const item of items) {
    const family = familyOfModel(item.slug ?? item.model ?? "");
    const role = roleFromDescription(item.description ?? "");
    if (family && role) map.set(family, role);
  }
  return map;
}

async function codexCatalog(codexHome) {
  let cache;
  try { cache = JSON.parse(await fs.readFile(path.join(codexHome, "models_cache.json"), "utf8")); }
  catch { return { available: false, models: [] }; }
  const visible = (Array.isArray(cache?.models) ? cache.models : [])
    .filter(item => item && typeof item.slug === "string" && (item.visibility ?? "list") === "list");
  const familyRoles = buildFamilyRoleMap(visible);
  const models = visible
    .map(item => ({ model: item.slug, description: String(item.description ?? "").slice(0, 120),
      category: classifyModelRole(item.slug, item.description, familyRoles),
      priority: Number.isFinite(item.priority) ? item.priority : 999,
      efforts: (item.supported_reasoning_levels ?? []).map(level => level?.effort).filter(effort => typeof effort === "string") }));
  return { available: true, fetchedAt: cache.fetched_at ?? null, models };
}

// A top-level `profile` selects the [profiles.<name>] table whose values override the top-level ones.
async function codexCurrent(codexHome) {
  let config;
  try { config = getStaticTOMLValue(parseTOML(await fs.readFile(path.join(codexHome, "config.toml"), "utf8"))); } catch { return null; }
  const text = (table, key) => typeof table?.[key] === "string" && table[key] ? table[key] : null;
  const chosen = typeof config.profile === "string" && Object.hasOwn(config.profiles ?? {}, config.profile) ? config.profiles[config.profile] : null;
  return { model: text(chosen, "model") ?? text(config, "model"), effort: text(chosen, "model_reasoning_effort") ?? text(config, "model_reasoning_effort") };
}

// Claude Code saves the choice of /model in settings.json; a session started with --model may differ.
async function claudeCurrent(claudeHome) {
  let settings;
  try { settings = JSON.parse(await fs.readFile(path.join(claudeHome, "settings.json"), "utf8")); } catch { return null; }
  const value = key => typeof settings?.[key] === "string" && settings[key] ? settings[key] : null;
  return { model: value("model"), effort: value("effortLevel") };
}

// The newest model of the category that supports the effort; a newer one without it must not hide an older one that does.
function pick(models, wanted, effort) {
  return models.filter(item => item.category === wanted && item.efforts.includes(effort)).sort((a, b) => a.priority - b.priority)[0] ?? null;
}

export async function agentModels({ codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
  claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude") } = {}) {
  const codex = await codexCatalog(codexHome);
  const levels = LEVELS.map(entry => {
    const codexModel = pick(codex.models, entry.category, entry.effort);
    const claudeModel = CLAUDE.find(item => item.category === entry.category);
    return { ...entry, claude: { model: claudeModel.model, effort: entry.effort },
      codex: codexModel ? { model: codexModel.model, effort: entry.effort } : null };
  });
  return { claude: CLAUDE, codex, codexCurrent: await codexCurrent(codexHome), claudeCurrent: await claudeCurrent(claudeHome), levels };
}

export function agentModelsTable({ claude, codex, codexCurrent, claudeCurrent, levels }) {
  const lines = ["**Modelos disponibles**", "", "| Agente | Modelo | Categoría | Esfuerzos |", "| --- | --- | --- | --- |"];
  for (const item of claude) lines.push(`| Claude | \`${item.model}\` | ${item.category} | ${item.efforts.join(", ")} |`);
  if (!codex.available) lines.push("| Codex | — | — | No se encontró `models_cache.json`; abre Codex una vez |");
  for (const item of codex.models) lines.push(`| Codex | \`${item.model}\` | ${item.category} | ${item.efforts.join(", ")} |`);
  lines.push("", "**Niveles con los modelos actuales**", "", "| Nivel | Total | Claude | Codex |", "| --- | --- | --- | --- |");
  for (const entry of levels) {
    const codexCell = entry.codex ? `\`${entry.codex.model}\`, \`${entry.codex.effort}\`` : "Sin modelo de esa categoría";
    lines.push(`| ${entry.level} | ${entry.total} | \`${entry.claude.model}\`, \`${entry.claude.effort}\` | ${codexCell} |`);
  }
  lines.push("", codexCurrent?.model
    ? `Codex usa ahora: \`${codexCurrent.model}\`, \`${codexCurrent.effort ?? "sin esfuerzo fijado"}\`.`
    : "No se pudo leer la configuración actual de Codex.");
  lines.push(claudeCurrent?.model || claudeCurrent?.effort
    ? `Claude tiene guardado: \`${claudeCurrent.model ?? "sin modelo fijado"}\`, \`${claudeCurrent.effort ?? "sin esfuerzo fijado"}\` (lo que dejó \`/model\`; una sesión iniciada con \`--model\` puede diferir).`
    : "No se pudo leer la configuración guardada de Claude.");
  lines.push("La categoría de Codex se deduce de la descripción de cada modelo; «anterior» no se recomienda.", "");
  return lines.join("\n");
}
