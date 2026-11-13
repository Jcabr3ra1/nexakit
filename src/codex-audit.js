import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseTOML, getStaticTOMLValue } from 'toml-eslint-parser';

const MAX_FILE = 256 * 1024;
const MAX_METADATA = 8192;
const MAX_ENTRIES = 512;
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const countTables = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : 0;

function selectSettings(config) {
  const settings = {};
  // Only short, conventional model identifiers and known enum values are exposed.
  if (typeof config.model === 'string' && /^(?:gpt-|o[1-9]|codex-)[a-z0-9.-]{1,70}$/.test(config.model)) settings.model = config.model;
  if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(config.model_reasoning_effort)) settings.model_reasoning_effort = config.model_reasoning_effort;
  if (['fast', 'flex', 'standard', 'default', 'auto'].includes(config.service_tier)) settings.service_tier = config.service_tier;
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  if (integer(config.tool_output_token_limit)) settings.tool_output_token_limit = config.tool_output_token_limit;
  if (integer(config.skills?.max_context_tokens)) settings.skills = { max_context_tokens: config.skills.max_context_tokens };
  if (integer(config.agents?.max_concurrent_threads_per_session)) settings.agents = { max_concurrent_threads_per_session: config.agents.max_concurrent_threads_per_session };
  return settings;
}

/** Bounded local audit: only whitelisted settings and validated relative locators are exposed. */
export function auditCodex({ projectRoot = process.cwd(), codexHome, homeDirectory = os.homedir() } = {}) {
  codexHome = path.resolve(codexHome ?? process.env.CODEX_HOME ?? path.join(homeDirectory, '.codex'));
  projectRoot = path.resolve(projectRoot);
  homeDirectory = path.resolve(homeDirectory);
  const report = {
    findings: [],
    coverage: {
      partial: true,
      inspected: ['codex-home-config', 'skill-catalog-metadata', 'user-project-instructions'],
      notInspected: ['remote-plugins', 'profiles', 'project-config', 'ancestor-instructions'],
      message: 'Auditoría parcial: no se inspeccionan plugins remotos, perfiles, configuración del proyecto ni instrucciones de ancestros; los enlaces externos se omiten.',
    },
    summary: { skills: 0, skillBytes: 0, metadataBytes: 0, instructionFiles: 0, instructionBytes: 0, mcpServers: 0, plugins: 0, omitted: 0 },
    recommendations: [
      { code: 'CATALOG_BUDGET', setting: 'skills.max_context_tokens', message: 'Usar el presupuesto nativo del catálogo de skills; antes de reducirlo, comprobar advertencias, descripciones y omisiones.' },
      { code: 'OUTPUT_BUDGET', setting: 'tool_output_token_limit', proposedValue: 4000, officialDefault: false, message: 'Propuesta local: evaluar 4000 tokens por salida y recuperar el log completo cuando haga falta; no es un valor predeterminado oficial.' },
      { code: 'EFFORT', message: 'Elegir esfuerzo proporcional a la tarea y comprobar calidad antes de reducirlo; no se modifica la configuración.' },
      { code: 'DELEGATION', message: 'Delegar tareas independientes con encargos breves y limitar la concurrencia según la tarea; no se modifica la configuración.' },
      { code: 'MCP', message: 'Revisar los MCP y plugins habilitados y habilitar solo los necesarios para la tarea; no se cambia ninguno.' },
    ],
    settings: {},
  };
  const finding = (code, message, fields = {}) => report.findings.push({ code, severity: code.endsWith('MISSING') ? 'info' : 'warning', message, ...fields });
  const omit = scope => { report.summary.omitted++; finding('PATH_OMITTED', 'Ruta o enlace omitido por estar fuera del ámbito autorizado.', { scope }); };
  const issue = (error, scope) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') finding('READ_FAILED', 'No se pudo inspeccionar un archivo local.', { scope });
  };
  const realBase = base => { try { return fs.realpathSync(base); } catch { return path.resolve(base); } };

  // A caller-selected base is authorized; symlinks below it must stay inside it.
  function safeFile(file, roots, scope, allowSymlink = false) {
    try {
      if (!allowSymlink && fs.lstatSync(file).isSymbolicLink()) { omit(scope); return null; }
      const real = fs.realpathSync(file);
      if (!roots.some(root => inside(root, real))) { omit(scope); return null; }
      const descriptor = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile()) { fs.closeSync(descriptor); omit(scope); return null; }
      return { descriptor, stat, real };
    } catch (error) { issue(error, scope); return null; }
  }
  function readSmall(file, root, scope) {
    const opened = safeFile(file, [realBase(root)], scope);
    if (!opened) return null;
    try {
      if (opened.stat.size > MAX_FILE) { finding('READ_LIMIT', 'Archivo omitido por superar el límite de lectura.', { scope, limitBytes: MAX_FILE }); return null; }
      // Fixed buffer also bounds reads if the file grows after fstat.
      const buffer = Buffer.alloc(MAX_FILE + 1);
      const length = fs.readSync(opened.descriptor, buffer, 0, buffer.length, 0);
      if (length > MAX_FILE) { finding('READ_LIMIT', 'Archivo omitido por superar el límite de lectura.', { scope, limitBytes: MAX_FILE }); return null; }
      return buffer.subarray(0, length);
    } finally { fs.closeSync(opened.descriptor); }
  }

  const configText = readSmall(path.join(codexHome, 'config.toml'), codexHome, 'config');
  if (configText) {
    try {
      const config = getStaticTOMLValue(parseTOML(configText.toString('utf8')));
      report.settings = selectSettings(config);
      report.summary.mcpServers = countTables(config.mcp_servers);
      report.summary.plugins = countTables(config.plugins);
    } catch { finding('CONFIG_INVALID', 'TOML inválido; se omiten los valores de configuración.'); }
  } else {
    try { fs.lstatSync(path.join(codexHome, 'config.toml')); }
    catch (error) { if (error.code === 'ENOENT') finding('CONFIG_MISSING', 'No hay configuración de Codex en este ámbito.'); }
  }

  const catalogs = [
    { scope: 'user-skills', base: homeDirectory, root: path.join(homeDirectory, '.agents/skills') },
    { scope: 'codex-skills', base: codexHome, root: path.join(codexHome, 'skills') },
    { scope: 'project-skills', base: projectRoot, root: path.join(projectRoot, '.agents/skills') },
  ];
  const roots = [];
  for (const catalog of catalogs) {
    try {
      let component = catalog.base;
      let linked = false;
      for (const part of path.relative(catalog.base, catalog.root).split(path.sep)) {
        component = path.join(component, part);
        if (fs.lstatSync(component).isSymbolicLink()) { linked = true; break; }
      }
      if (linked) { omit(catalog.scope); continue; }
      const real = fs.realpathSync(catalog.root);
      if (!inside(realBase(catalog.base), real)) { omit(catalog.scope); continue; }
      roots.push({ ...catalog, real });
    } catch (error) { issue(error, catalog.scope); }
  }
  const allowedRoots = roots.map(root => root.real);
  const seenFiles = new Set();
  const names = new Map();
  let entries = 0;
  let limited = false;

  function metadata(file, scope, directory) {
    const opened = safeFile(file, allowedRoots, scope, true);
    if (!opened) return;
    try {
      if (seenFiles.has(opened.real)) return;
      seenFiles.add(opened.real);
      report.summary.skills++;
      report.summary.skillBytes += opened.stat.size;
      // Stop exactly at the frontmatter closing line, without reading the body.
      const bytes = Buffer.alloc(MAX_METADATA);
      let used = 0;
      let lineStart = 0;
      let closed = false;
      while (used < bytes.length) {
        if (!fs.readSync(opened.descriptor, bytes, used, 1, null)) {
          if (lineStart > 0 && bytes.subarray(lineStart, used).toString('utf8').trim() === '---') closed = true;
          break;
        }
        used++;
        if (bytes[used - 1] !== 10) continue;
        const line = bytes.subarray(lineStart, used).toString('utf8').trim();
        if (lineStart === 0 && line !== '---') break;
        if (lineStart > 0 && line === '---') { closed = true; break; }
        lineStart = used;
      }
      report.summary.metadataBytes += used;
      if (!closed) {
        finding(used === MAX_METADATA ? 'READ_LIMIT' : 'SKILL_METADATA_INVALID', 'Metadatos omitidos por ser incompletos o superar el límite.', { scope, limitBytes: MAX_METADATA });
        return;
      }
      const lines = bytes.subarray(0, used).toString('utf8').split(/\r?\n/);
      const scalar = key => {
        const index = lines.findIndex(line => line.startsWith(`${key}:`));
        if (index < 0) return '';
        let value = lines[index].slice(key.length + 1).trim();
        if (/^[>|][-+]?$/.test(value)) {
          value = '';
          for (let i = index + 1; i < lines.length && /^\s/.test(lines[i]); i++) value += ` ${lines[i].trim()}`;
        }
        return value.replace(/^(['"])(.*)\1$/, '$2').trim();
      };
      const name = scalar('name');
      const description = scalar('description');
      const location = {
        scope,
        directory: directory.length <= 220 && directory.split('/').every(part => part === '.system' || /^[a-z0-9][a-z0-9._-]{0,99}$/.test(part)) ? directory : 'omitido',
      };
      const locator = { skillName: /^[a-z0-9-]{1,100}$/.test(name) ? name : 'omitido', locations: [location] };
      if (!name || !description) finding('SKILL_METADATA_INVALID', 'La skill no tiene nombre o descripción utilizable.', { scope });
      if (name) names.set(name, [...(names.get(name) ?? []), location]);
      if (description.length > 1024) finding('SKILL_DESCRIPTION_LONG', 'Descripción extensa; conviene delimitar cuándo usar la skill.', { ...locator, characters: description.length });
      if (/\b(everything|anything|all tasks|any task|siempre|todo|cualquier tarea)\b/i.test(description)) finding('SKILL_DESCRIPTION_BROAD', 'Descripción amplia; conviene acotar sus condiciones de activación.', locator);
    } finally { fs.closeSync(opened.descriptor); }
  }
  function scan(directory, scope, depth = 0, prefix = '') {
    let handle;
    try {
      handle = fs.opendirSync(directory);
      for (let entry; (entry = handle.readSync());) {
        if (entries >= MAX_ENTRIES) { limited = true; break; }
        entries++;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        try {
          const child = path.join(directory, entry.name);
          const real = fs.realpathSync(child);
          if (!allowedRoots.some(root => inside(root, real))) { omit(scope); continue; }
          const relativeDirectory = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.name === '.system' && depth === 0) scan(real, scope, 1, relativeDirectory);
          else metadata(path.join(real, 'SKILL.md'), scope, relativeDirectory);
        } catch (error) {
          if (entry.isSymbolicLink()) omit(scope);
          else issue(error, scope);
        }
      }
    } catch (error) { issue(error, scope); }
    finally { handle?.closeSync(); }
  }
  for (const root of roots) scan(root.real, root.scope);
  if (limited) finding('CATALOG_LIMIT', 'Catálogo parcial: se alcanzó el límite global de entradas.', { limit: MAX_ENTRIES });
  for (const [name, locations] of names) if (locations.length > 1) finding('SKILL_DUPLICATE_NAME', 'Varias skills comparten el mismo nombre.', {
    skillName: /^[a-z0-9-]{1,100}$/.test(name) ? name : 'omitido', locations, count: locations.length,
  });

  const hashes = new Map();
  for (const [base, scope] of [[codexHome, 'user-instructions'], [projectRoot, 'project-instructions']]) {
    const text = readSmall(path.join(base, 'AGENTS.md'), base, scope);
    if (!text) continue;
    report.summary.instructionFiles++;
    report.summary.instructionBytes += text.length;
    if (!text.toString('utf8').trim()) continue;
    const hash = createHash('sha256').update(text).digest('hex');
    hashes.set(hash, (hashes.get(hash) ?? 0) + 1);
  }
  for (const count of hashes.values()) if (count > 1) finding('INSTRUCTIONS_DUPLICATE', 'Las instrucciones de usuario y proyecto son idénticas.', { count });
  return report;
}
