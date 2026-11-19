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

// Cuantil del 5 % de una Beta(alfa, beta), el mismo criterio prudente que el enrutador de la fábrica
// (src/fabrica/evidencia.ts `cuantil05`; esta skill es autocontenida y no puede importarlo). Con pocos datos queda lejos
// de la media: un 3/3 no gana a un 40/50. Lanczos para ln Γ, fracción continua de Lentz y bisección sobre [0, 1].
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
];
const lnGamma = x => {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z0 = x - 1;
  let suma = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i += 1) suma += LANCZOS[i] / (z0 + i);
  const t = z0 + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z0 + 0.5) * Math.log(t) - t + Math.log(suma);
};
const fraccionContinua = (a, b, x) => {
  const TINY = 1e-300, EPS = 1e-15, qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 20_000; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c; if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
};
const betaIncompleta = (a, b, x) => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const factor = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2) ? (factor * fraccionContinua(a, b, x)) / a : 1 - (factor * fraccionContinua(b, a, 1 - x)) / b;
};
const cuantil05 = (alfa, beta) => {
  let bajo = 0, alto = 1;
  for (let i = 0; i < 100; i += 1) {
    const medio = (bajo + alto) / 2;
    const acumulada = betaIncompleta(alfa, beta, medio);
    if (!Number.isFinite(acumulada)) return null;
    if (acumulada < 0.05) bajo = medio; else alto = medio;
  }
  return (bajo + alto) / 2;
};
// Coste para desempatar como el enrutador: menos tokens antes, y sin tokens medidos (0) detrás.
const coste = f => (Number.isFinite(f.tokensMedios) && f.tokensMedios > 0 ? f.tokensMedios : Number.POSITIVE_INFINITY);

// Evidencia medida por la fábrica de nexakit. Solo lectura, sin seguir enlaces y con tope de tamaño: si no existe o no
// es válida, no se imprime nada. Las filas de Claude no entran: su «modelo» es el nombre de un agente, no un modelo.
const evidenciaMedida = () => {
  const file = path.join(home, '.nexakit', 'fabrica', 'evidencia.json');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.filas)) return null;
    const mejores = new Map();
    for (const f of data.filas) {
      if (!f || typeof f.estacion !== 'string' || typeof f.modelo !== 'string' || typeof f.ia !== 'string') return null;
      if (![f.alfa, f.beta, f.banco, f.real].every(Number.isFinite) || f.alfa < 1e-6 || f.beta < 1e-6 || f.alfa > 1e9 || f.beta > 1e9) return null;
      if (f.ia === 'claude') continue;
      const calidad = cuantil05(f.alfa, f.beta);
      if (calidad === null) return null;
      const actual = mejores.get(f.estacion);
      if (!actual || calidad > actual.calidad || (calidad === actual.calidad && coste(f) < coste(actual.fila))) {
        mejores.set(f.estacion, { fila: f, calidad });
      }
    }
    return mejores;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* nada */ }
  }
};
const limpio = texto => String(texto).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ');
const mejores = evidenciaMedida();
if (mejores && mejores.size > 0) {
  out('', '## Evidencia medida');
  // Hacia abajo a dos decimales, como la fábrica: nunca promete más de lo medido.
  const calidadTexto = q => (Math.floor(q * 100 + 1e-9) / 100).toFixed(2).replace('.', ',');
  for (const [estacion, { fila, calidad }] of [...mejores].sort((a, b) => a[0].localeCompare(b[0]))) {
    const esfuerzo = typeof fila.esfuerzo === 'string' ? ` · ${limpio(fila.esfuerzo)}` : '';
    out(`- ${limpio(estacion)}: ${limpio(fila.ia)} · ${limpio(fila.modelo)}${esfuerzo} · calidad ≥ ${calidadTexto(calidad)} · ${fila.banco + fila.real} observaciones (${fila.banco} de banco, ${fila.real} reales)`);
  }
  out('Nota: la calidad es el cuantil del 5 % de la Beta, el mismo criterio que la fábrica; la fábrica además la compara con el umbral del riesgo y elige el más barato que lo alcanza.');
}

process.stdout.write(lines.join('\n') + '\n');
