#!/usr/bin/env node
// Prints, from the real sources on this machine, the models and effort levels each AI accepts and what each one
// has stored now. It has no dependencies, so any agent can run it with `node`, and it writes nothing.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const env = process.env;
const lines = [];
const out = (...text) => lines.push(...text);
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const readJson = file => { try { return JSON.parse(readText(file)); } catch { return null; } };
const short = file => (file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file);
const FAMILY_ROLES = Object.freeze({
  luna: 'ligero',
  flash: 'ligero',
  haiku: 'ligero',
  terra: 'uso diario',
  sol: 'uso diario',
  sonnet: 'uso diario',
  hydrogen: 'uso diario',
  astra: 'el más capaz',
  argon: 'el más capaz',
  carbon: 'el más capaz',
  opus: 'el más capaz'
});
const roleFromDescription = (description = '') => {
  if (/\b(fast and (affordable|efficient)|easier tasks|lightweight)\b/iu.test(description)) return 'ligero';
  if (/\b(frontier|most demanding)\b/iu.test(description)) return 'el más capaz';
  if (/\b(workhorse|everyday|balanced|straightforward work)\b/iu.test(description)) return 'uso diario';
  return null;
};
const familyOf = (slug = '') => {
  const base = String(slug).replace(/-(?:low|medium|high|xhigh|max|ultra)$/iu, '');
  const known = base.match(/\b(luna|terra|sol|astra|flash|argon|haiku|sonnet|opus)\b/iu);
  if (known) return known[1].toLowerCase();
  const family = base.match(/^(?:gpt|gemini|claude)-\d+(?:\.\d+)*-([a-z][a-z0-9]*)$/iu);
  return family ? family[1].toLowerCase() : null;
};
const classifyRole = (slug = '', description = '', familyRoles = new Map(Object.entries(FAMILY_ROLES))) => {
  if (/\b(older|previous)\b/iu.test(description)) return 'anterior';
  const direct = roleFromDescription(description);
  if (direct) return direct;
  const family = familyOf(slug);
  if (family && familyRoles.has(family)) return familyRoles.get(family);
  return 'sin clasificar';
};

// Claude Code: aliases are stable and the CLI publishes no catalog, so they are listed here.
const claudeDir = env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude');
const settings = readJson(path.join(claudeDir, 'settings.json')) ?? {};
out('## Claude Code',
  'Modelos: haiku · sonnet · opus · opusplan (Opus planifica, Sonnet ejecuta) · fable, si tu cuenta lo tiene',
  'Esfuerzos: low, medium, high, xhigh, max · por defecto medium (Opus, Sonnet y Haiku 5.5) y high (Fable)',
  `Guardado: model=${settings.model ?? '(por defecto)'} · effortLevel=${settings.effortLevel ?? '(por defecto)'}` +
    (settings.modelSettings ? ` · modelSettings=${JSON.stringify(settings.modelSettings)}` : ''));
if (env.CLAUDE_CODE_EFFORT_LEVEL) out(`! CLAUDE_CODE_EFFORT_LEVEL=${env.CLAUDE_CODE_EFFORT_LEVEL} manda sobre cualquier otro ajuste de esfuerzo.`);
if (env.ANTHROPIC_MODEL) out(`! ANTHROPIC_MODEL=${env.ANTHROPIC_MODEL} fija el modelo de las sesiones que se abren con ella.`);
out('La sesión abierta puede ser distinta: compruébala con /model y /effort status.', '');

// Codex publishes its catalog, with each model's own default effort.
const codexHome = env.CODEX_HOME ?? path.join(home, '.codex');
const cacheFile = path.join(codexHome, 'models_cache.json');
const cache = readJson(cacheFile);
out('## Codex');
const models = Array.isArray(cache?.models) ? cache.models : null;
if (!models) out(`No encontré ${short(cacheFile)}: abre Codex una vez.`);
const visibleCodex = (models ?? []).filter(model => model.visibility !== 'hide' && typeof model.slug === 'string');
const codexFamilyRoles = new Map(Object.entries(FAMILY_ROLES));
for (const model of visibleCodex) {
  const family = familyOf(model.slug);
  const role = roleFromDescription(model.description ?? '');
  if (family && role) codexFamilyRoles.set(family, role);
}
for (const model of visibleCodex) {
  const levels = (model.supported_reasoning_levels ?? []).map(level => level.effort).join(', ');
  const role = classifyRole(model.slug, model.description ?? '', codexFamilyRoles);
  out(`- ${model.slug} · por defecto ${model.default_reasoning_level ?? '?'} · ${levels} · ${model.description ?? ''} · papel: ${role}`.trimEnd());
}
// Only the top-level keys: profile tables come later in the file and apply only with --profile.
const config = readText(path.join(codexHome, 'config.toml')) ?? '';
const topLevel = config.split(/^\s*\[/mu)[0];
const key = name => topLevel.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, 'mu'))?.[1] ?? '(por defecto)';
out(`Guardado: model=${key('model')} · model_reasoning_effort=${key('model_reasoning_effort')}`,
  'La sesión abierta puede ser distinta (un perfil o --model): compruébala con /status.', '');

// Antigravity lists its models on demand; the effort is part of each id.
out('## Antigravity');
// On Windows npm installs agy as agy.cmd, which only runs through the shell.
const windows = process.platform === 'win32';
const agy = spawnSync('agy', ['models'], { encoding: 'utf8', timeout: 20_000, shell: windows });
const missing = agy.error?.code === 'ENOENT' || (windows && agy.status !== 0 && /not recognized|no se reconoce/iu.test(agy.stderr ?? ''));
if (missing) {
  out('agy no está instalado.');
} else if (agy.error || agy.status !== 0) {
  out(`agy models falló: ${(agy.stderr || agy.error?.message || `código ${agy.status}`).trim().split('\n')[0]}`);
} else {
  for (const row of (agy.stdout ?? '').split('\n')) {
    const [id, label] = row.split('\t');
    if (id && label) {
      const role = classifyRole(id.trim(), label.trim());
      out(`- ${id.trim()} · ${label.trim()} · papel: ${role}`);
    }
  }
  out('El id indica el esfuerzo cuando el modelo ofrece variantes: -low, -medium, -high, -xhigh o -max. Comprueba el modelo y el esfuerzo activos con /model y /effort dentro de agy.');
}

process.stdout.write(lines.join('\n') + '\n');
