import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { IS_WINDOWS } from "./platform.js";
import { resolveCliInvocation } from "./cli-executable.js";

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_PATH = path.resolve(
  SOURCE_DIRECTORY,
  "../schemas/project-memory.schema.json"
);
const FILESYSTEM_PACKAGE = "@modelcontextprotocol/server-filesystem";
const FILESYSTEM_VERSION = "2.3.0";
const FILESYSTEM_SPEC = `${FILESYSTEM_PACKAGE}@${FILESYSTEM_VERSION}`;
// `--read-only`: the server itself withholds every tool that writes, whatever the client allows.
// `--confine-roots`: a client's Roots cannot replace the vault with another directory.
const FILESYSTEM_FLAGS = Object.freeze(["--read-only", "--confine-roots"]);
const filesystemLaunch = (vaultPath) => ["npx", "-y", FILESYSTEM_SPEC, ...FILESYSTEM_FLAGS, vaultPath];

export const READ_TOOLS = Object.freeze([
  "read_text_file",
  "read_media_file",
  "read_multiple_files",
  "list_directory",
  "list_directory_with_sizes",
  "directory_tree",
  "search_files",
  "get_file_info",
  "list_allowed_directories"
]);

export const WRITE_TOOLS = Object.freeze([
  "create_directory",
  "write_file",
  "edit_file",
  "move_file",
  "append_file",
  "copy_file"
]);

const ADAPTERS = Object.freeze({
  codex: {
    skillDirectory: ".agents/skills"
  },
  claude: {
    skillDirectory: ".claude/skills"
  },
  antigravity: {
    skillDirectory: ".gemini/antigravity-cli/skills"
  }
});
// The command each agent is driven with.
const AGENT_COMMANDS = Object.freeze({ codex: "codex", claude: "claude", antigravity: "agy" });
const MEMORY_SCRIPT = path.join("bin", "project-memory-mcp.js");
const OUTDATED_MESSAGE = `Actualizar el servidor de la memoria a la versión ${FILESYSTEM_VERSION}, en solo lectura.`;

export async function connectMemory(options, context = {}) {
  const config = loadConfig(options, context);
  const runner = context.runCommand ?? (IS_WINDOWS ? await windowsCommandRunner(AGENT_COMMANDS[config.agentId]) : runCommand);
  const skill = inspectSkill(config);
  const connection = inspectConnection(config, runner, context);
  const components = [skill, ...connection.components];
  const report = createReport(config, components, options.apply === true);

  if (components.some((component) => component.action === "conflict")) {
    report.status = "conflict";
    return report;
  }

  if (!options.apply) {
    report.status = "preview";
    return report;
  }

  let skillCreated = false;
  try {
    skillCreated = applySkill(skill);
    connection.apply();
  } catch (error) {
    if (skillCreated && isSymbolicLinkTo(skill.path, skill.source)) {
      fs.unlinkSync(skill.path);
    }
    throw new ConnectionError([
      error instanceof Error ? error.message : String(error)
    ]);
  }

  report.status = components.every(
    (component) => component.action === "unchanged"
  )
    ? "unchanged"
    : "connected";
  return report;
}

function loadConfig(options, context) {
  const errors = [];
  const target = path.resolve(options.targetPath ?? process.cwd());
  const manifestPath = resolveManifestPath(target, options.manifestPath);
  const agentId = options.agentId?.trim();

  if (!manifestPath) {
    errors.push("No se encontró project-memory.json.");
  }
  if (!ADAPTERS[agentId]) {
    errors.push("--agent debe ser codex, claude o antigravity.");
  }
  if (errors.length > 0) {
    throw new ConnectionError(errors);
  }

  const manifest = readJson(manifestPath, "manifiesto");
  const schemaPath = path.resolve(context.schemaPath ?? DEFAULT_SCHEMA_PATH);
  const schema = readJson(schemaPath, "esquema");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);

  if (!validate(manifest)) {
    throw new ConnectionError(
      (validate.errors ?? []).map((error) => {
        const location = error.instancePath || "/";
        return `${location}: ${error.message}`;
      })
    );
  }

  const agent = manifest.agents.find((candidate) => candidate.id === agentId);
  if (!agent) {
    errors.push(`El manifiesto no declara el agente ${agentId}.`);
  } else if (!agent.enabled) {
    errors.push(`El agente ${agentId} está deshabilitado en el manifiesto.`);
  }

  const manifestDirectory = path.dirname(manifestPath);
  const vaultPath = resolveConfiguredPath(
    manifestDirectory,
    manifest.memory.vaultPath
  );
  const skillName = agent?.skillName ?? manifest.project.id;
  const skillSource = path.join(
    vaultPath,
    "07-AGENTES",
    "skills",
    skillName
  );

  if (!isDirectory(vaultPath)) {
    errors.push(`La bóveda no existe: ${vaultPath}`);
  }
  if (!isDirectory(skillSource) || !isFile(path.join(skillSource, "SKILL.md"))) {
    errors.push(`No se encontró una Skill válida: ${skillSource}`);
  }
  if (manifest.security.mcpAccess !== "read-only") {
    errors.push("La conexión exige security.mcpAccess = read-only.");
  }

  if (errors.length > 0) {
    throw new ConnectionError(errors);
  }

  const homeDirectory = path.resolve(context.homeDirectory ?? os.homedir());
  const adapter = ADAPTERS[agentId];

  return {
    agentId,
    adapter,
    manifest,
    manifestPath,
    vaultPath: fs.realpathSync(vaultPath),
    skillName,
    skillSource: fs.realpathSync(skillSource),
    skillTarget: path.join(homeDirectory, adapter.skillDirectory, skillName),
    homeDirectory,
    mcpName: manifest.memory.mcpServerName
  };
}

function inspectSkill(config) {
  const target = config.skillTarget;

  if (!pathEntryExists(target)) {
    return {
      id: "skill",
      action: "create",
      path: target,
      source: config.skillSource,
      message: "Crear enlace simbólico hacia la Skill canónica."
    };
  }

  const stats = fs.lstatSync(target);
  if (!stats.isSymbolicLink()) {
    return {
      id: "skill",
      action: "conflict",
      path: target,
      source: config.skillSource,
      message: "El destino existe y no es un enlace simbólico."
    };
  }

  let currentSource;
  try {
    currentSource = fs.realpathSync(target);
  } catch {
    return {
      id: "skill",
      action: "conflict",
      path: target,
      source: config.skillSource,
      message: "El destino es un enlace simbólico roto."
    };
  }
  if (!samePath(currentSource, config.skillSource)) {
    return {
      id: "skill",
      action: "conflict",
      path: target,
      source: config.skillSource,
      message: `El enlace apunta a otra ubicación: ${currentSource}`
    };
  }

  return {
    id: "skill",
    action: "unchanged",
    path: target,
    source: config.skillSource,
    message: "La Skill ya apunta a la fuente canónica."
  };
}

function inspectConnection(config, runner, context) {
  if (config.agentId === "codex") {
    return inspectCodex(config, runner);
  }
  if (config.agentId === "antigravity") {
    return inspectAntigravity(config, runner, context);
  }
  return inspectClaude(config, runner);
}

function inspectCodex(config, runner) {
  const result = runner("codex", ["mcp", "get", config.mcpName]);
  if (result.errorCode === "ENOENT") {
    return unavailableCommand("codex");
  }

  const exists = result.status === 0;
  const matches = exists && outputMatchesFilesystemServer(result.stdout, config);
  const mcp = exists
    ? matches === "current"
      ? component("mcp", "unchanged", "Codex ya usa esta bóveda.")
      : matches === "outdated"
        ? component("mcp", "update", OUTDATED_MESSAGE)
        : component("mcp", "conflict", "Codex tiene un MCP homónimo diferente.")
    : component("mcp", "create", "Registrar el MCP personal en Codex.");

  const currentTools = parseCodexEnabledTools(result.stdout);
  const policy = !exists
    ? component("policy", "create", "Crear la lista blanca de lectura de Codex.")
    : hasEvery(currentTools, READ_TOOLS) && !hasAny(currentTools, WRITE_TOOLS)
      ? component("policy", "unchanged", "Codex ya limita el MCP a lectura.")
      : component("policy", "update", "Limitar el MCP de Codex a herramientas de lectura.");

  const configPath = path.join(config.homeDirectory, ".codex/config.toml");
  if (
    policy.action !== "unchanged" &&
    pathEntryExists(configPath) &&
    fs.lstatSync(configPath).isSymbolicLink()
  ) {
    policy.action = "conflict";
    policy.message = "La configuración de Codex es un enlace simbólico y no se reemplazará.";
  }
  mcp.path = configPath;
  policy.path = configPath;

  return {
    components: [mcp, policy],
    apply() {
      let serverCreated = false;
      try {
        if (mcp.action === "update") {
          requireSuccess(runner("codex", ["mcp", "remove", config.mcpName]), "No se pudo retirar el MCP anterior de Codex.");
        }
        if (mcp.action === "create" || mcp.action === "update") {
          requireSuccess(
            runner("codex", ["mcp", "add", config.mcpName, "--", ...filesystemLaunch(config.vaultPath)]),
            "No se pudo registrar el MCP en Codex."
          );
          serverCreated = true;
        }
        // Removing the old entry drops its read-only tool list with it.
        if (policy.action !== "unchanged" || mcp.action === "update") {
          updateCodexPolicy(configPath, config.mcpName);
        }
      } catch (error) {
        if (serverCreated) {
          runner("codex", ["mcp", "remove", config.mcpName]);
        }
        throw error;
      }
    }
  };
}

function inspectClaude(config, runner) {
  const result = runner("claude", ["mcp", "get", config.mcpName]);
  if (result.errorCode === "ENOENT") {
    return unavailableCommand("claude");
  }

  const exists = result.status === 0;
  const matches = exists && outputMatchesFilesystemServer(result.stdout, config);
  const mcp = exists
    ? matches === "current"
      ? component("mcp", "unchanged", "Claude ya usa esta bóveda.")
      : matches === "outdated"
        ? component("mcp", "update", OUTDATED_MESSAGE)
        : component("mcp", "conflict", "Claude tiene un MCP homónimo diferente.")
    : component("mcp", "create", "Registrar el MCP personal en Claude Code.");
  const settingsPath = path.join(config.homeDirectory, ".claude/settings.json");
  const policyState = inspectClaudePolicy(settingsPath, config.mcpName);
  const policy = component(
    "policy",
    policyState ? "unchanged" : fs.existsSync(settingsPath) ? "update" : "create",
    policyState
      ? "Claude ya permite lectura y deniega escritura para este MCP."
      : "Configurar permisos de lectura y bloqueos de escritura en Claude."
  );
  mcp.path = "Claude user MCP configuration";
  policy.path = settingsPath;
  if (
    policy.action !== "unchanged" &&
    pathEntryExists(settingsPath) &&
    fs.lstatSync(settingsPath).isSymbolicLink()
  ) {
    policy.action = "conflict";
    policy.message = "La configuración de Claude es un enlace simbólico y no se reemplazará.";
  }

  return {
    components: [mcp, policy],
    apply() {
      let serverCreated = false;
      try {
        if (mcp.action === "update") {
          requireSuccess(
            runner("claude", ["mcp", "remove", config.mcpName, "--scope", "user"]),
            "No se pudo retirar el MCP anterior de Claude Code."
          );
        }
        if (mcp.action === "create" || mcp.action === "update") {
          requireSuccess(
            runner("claude", [
              "mcp",
              "add",
              "--scope",
              "user",
              config.mcpName,
              "--",
              ...filesystemLaunch(config.vaultPath)
            ]),
            "No se pudo registrar el MCP en Claude Code."
          );
          serverCreated = true;
        }
        if (policy.action !== "unchanged") {
          updateClaudePolicy(settingsPath, config.mcpName);
        }
      } catch (error) {
        if (serverCreated) {
          runner("claude", ["mcp", "remove", config.mcpName, "--scope", "user"]);
        }
        throw error;
      }
    }
  };
}

// Antigravity cannot restrict the tools of an MCP server, so it gets nexakit's own memory server, which only has
// read tools, run from the active nexakit root. Its configuration is read from mcp_config.json, which keeps the
// exact arguments (the text of `agy mcp list` does not separate paths with spaces).
function inspectAntigravity(config, runner, context) {
  const probe = runner("agy", ["mcp", "list"]);
  if (probe.errorCode === "ENOENT") {
    const unavailable = unavailableCommand("agy");
    unavailable.components = unavailable.components.filter((item) => item.id === "mcp");
    return unavailable;
  }
  const nodePath = context.nodePath ?? process.execPath;
  const script = path.join(path.resolve(context.toolkitRoot ?? path.resolve(SOURCE_DIRECTORY, "..")), MEMORY_SCRIPT);
  const manifestPath = fs.realpathSync(config.manifestPath);
  const configPath = path.join(config.homeDirectory, ".gemini", "config", "mcp_config.json");
  let current;
  if (pathEntryExists(configPath)) {
    if (fs.lstatSync(configPath).isSymbolicLink()) {
      return { components: [component("mcp", "conflict", "La configuración de Antigravity es un enlace simbólico y no se reemplazará.")], apply() {} };
    }
    current = readJson(configPath, "configuración de Antigravity").mcpServers?.[config.mcpName];
  }
  const same = current && Array.isArray(current.args) && current.args.length === 3 &&
    samePath(current.args[0], script) && current.args[1] === "--manifest" && samePath(current.args[2], manifestPath) &&
    typeof current.command === "string" && /^node(\.exe)?$/iu.test(path.basename(current.command));
  const mcp = !current
    ? component("mcp", "create", "Registrar la memoria de solo lectura en Antigravity.")
    : same
      ? component("mcp", "unchanged", "Antigravity ya usa esta memoria.")
      : component("mcp", "conflict", "Antigravity tiene un MCP homónimo diferente.");
  mcp.path = configPath;
  return {
    components: [mcp],
    apply() {
      if (mcp.action === "create") {
        requireSuccess(
          runner("agy", ["mcp", "add", config.mcpName, "--", nodePath, script, "--manifest", manifestPath]),
          "No se pudo registrar el MCP en Antigravity."
        );
      }
    }
  };
}

function unavailableCommand(command) {
  return {
    components: [
      component("mcp", "conflict", `No se encontró el comando ${command}.`),
      component("policy", "conflict", "No se puede validar la política de acceso.")
    ],
    apply() {}
  };
}

function applySkill(skill) {
  if (skill.action !== "create") {
    return false;
  }
  fs.mkdirSync(path.dirname(skill.path), { recursive: true });
  fs.symlinkSync(path.resolve(skill.source), skill.path, IS_WINDOWS ? "junction" : "dir");
  return true;
}

function inspectClaudePolicy(settingsPath, mcpName) {
  if (!fs.existsSync(settingsPath)) {
    return false;
  }
  const settings = readJson(settingsPath, "configuración de Claude");
  const allow = settings.permissions?.allow;
  const deny = settings.permissions?.deny;
  return (
    hasEvery(
      allow,
      READ_TOOLS.map((tool) => claudeToolName(mcpName, tool))
    ) &&
    hasEvery(
      deny,
      WRITE_TOOLS.map((tool) => claudeToolName(mcpName, tool))
    )
  );
}

function updateClaudePolicy(settingsPath, mcpName) {
  const settings = fs.existsSync(settingsPath)
    ? readJson(settingsPath, "configuración de Claude")
    : {};
  settings.permissions ??= {};
  settings.permissions.allow = mergeUnique(
    settings.permissions.allow,
    READ_TOOLS.map((tool) => claudeToolName(mcpName, tool))
  );
  settings.permissions.deny = mergeUnique(
    settings.permissions.deny,
    WRITE_TOOLS.map((tool) => claudeToolName(mcpName, tool))
  );
  writeJsonAtomic(settingsPath, settings);
}

function updateCodexPolicy(configPath, mcpName) {
  if (!isFile(configPath)) {
    throw new Error(`Codex no creó su configuración: ${configPath}`);
  }
  const content = fs.readFileSync(configPath, "utf8");
  const escapedName = escapeRegExp(mcpName);
  const headerPattern = new RegExp(`^\\[mcp_servers\\.${escapedName}\\]\\s*$`, "m");
  const match = headerPattern.exec(content);
  if (!match) {
    throw new Error(`No se encontró el bloque MCP de Codex para ${mcpName}.`);
  }

  const blockStart = match.index;
  const contentAfterHeader = match.index + match[0].length;
  const nextHeaderOffset = content.slice(contentAfterHeader).search(/^\[/m);
  const blockEnd =
    nextHeaderOffset === -1 ? content.length : contentAfterHeader + nextHeaderOffset;
  const block = content.slice(blockStart, blockEnd);
  const arrayValue = `[${READ_TOOLS.map((tool) => JSON.stringify(tool)).join(", ")}]`;
  const policyPattern = /^enabled_tools\s*=.*$/m;
  const nextBlock = policyPattern.test(block)
    ? block.replace(policyPattern, `enabled_tools = ${arrayValue}`)
    : block.replace(match[0], `${match[0]}\nenabled_tools = ${arrayValue}`);
  const nextContent = `${content.slice(0, blockStart)}${nextBlock}${content.slice(blockEnd)}`;
  writeTextAtomic(configPath, nextContent);
}

function outputMatchesFilesystemServer(output, config) {
  const commandMatch = output.match(/^\s*Command:\s*(.+)$/im) ??
    output.match(/^\s*command:\s*(.+)$/im);
  const argsMatch = output.match(/^\s*Args:\s*(.+)$/im) ??
    output.match(/^\s*args:\s*(.+)$/im);
  if (!commandMatch || !argsMatch || commandMatch[1].trim() !== "npx") {
    return false;
  }
  return argsMatchFilesystem(argsMatch[1].trim(), config.vaultPath);
}

// "current": the pinned version started read-only and confined. "outdated": the same server for the same vault
// with another version or without those options, which `connect --apply` replaces. false: something else.
function argsMatchFilesystem(args, vaultPath) {
  const values = Array.isArray(args) ? args : splitCommandArguments(args);
  if (values.length < 3 || values[0] !== "-y" || !samePath(values.at(-1), vaultPath)) {
    return false;
  }
  if (values[1] !== FILESYSTEM_PACKAGE && !values[1].startsWith(`${FILESYSTEM_PACKAGE}@`)) {
    return false;
  }
  const flags = values.slice(2, -1);
  if (flags.some((flag) => !FILESYSTEM_FLAGS.includes(flag)) || new Set(flags).size !== flags.length) {
    return false;
  }
  return values[1] === FILESYSTEM_SPEC && flags.length === FILESYSTEM_FLAGS.length ? "current" : "outdated";
}

function isSymbolicLinkTo(candidate, expectedSource) {
  try {
    return (
      fs.lstatSync(candidate).isSymbolicLink() &&
      samePath(fs.realpathSync(candidate), fs.realpathSync(expectedSource))
    );
  } catch {
    return false;
  }
}

function samePath(left, right) {
  return IS_WINDOWS ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : left === right;
}

function splitCommandArguments(value) {
  const marker = value.indexOf(FILESYSTEM_PACKAGE);
  if (marker === -1) {
    return value.trim().split(/\s+/);
  }
  const packageEnd = value.indexOf(" ", marker);
  if (packageEnd === -1) {
    return value.trim().split(/\s+/);
  }
  const before = value.slice(0, packageEnd).trim().split(/\s+/);
  // The vault path may contain spaces: only the known options are split off before it.
  let vault = value.slice(packageEnd + 1).trim();
  const flags = [];
  for (;;) {
    const flag = FILESYSTEM_FLAGS.find((item) => vault === item || vault.startsWith(`${item} `));
    if (!flag) break;
    flags.push(flag);
    vault = vault.slice(flag.length).trim();
  }
  return [...before, ...flags, vault];
}

function parseCodexEnabledTools(output) {
  const match = output.match(/^\s*enabled_tools:\s*(.*)$/im);
  return match
    ? match[1]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
}

function createReport(config, components, apply) {
  return {
    command: "connect",
    status: "preview",
    mode: apply ? "apply" : "preview",
    agent: config.agentId,
    manifestPath: config.manifestPath,
    vaultPath: config.vaultPath,
    mcpName: config.mcpName,
    skillName: config.skillName,
    summary: {
      create: components.filter((item) => item.action === "create").length,
      update: components.filter((item) => item.action === "update").length,
      unchanged: components.filter((item) => item.action === "unchanged").length,
      conflicts: components.filter((item) => item.action === "conflict").length
    },
    components
  };
}

function component(id, action, message) {
  return { id, action, message };
}

function claudeToolName(mcpName, tool) {
  return `mcp__${mcpName}__${tool}`;
}

function hasEvery(values, expected) {
  return Array.isArray(values) && expected.every((value) => values.includes(value));
}

function hasAny(values, expected) {
  return Array.isArray(values) && expected.some((value) => values.includes(value));
}

function mergeUnique(current, additions) {
  return [...new Set([...(Array.isArray(current) ? current : []), ...additions])];
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    errorCode: result.error?.code
  };
}

async function windowsCommandRunner(name) {
  let invocation;
  try { invocation = await resolveCliInvocation({ name }); }
  catch (error) {
    if (error.code === "ENOENT") return () => ({ status: null, stdout: "", stderr: "", errorCode: "ENOENT" });
    throw new ConnectionError([error instanceof Error ? error.message : String(error)]);
  }
  return (_command, args) => runCommand(invocation.executable, [...invocation.argsPrefix, ...args]);
}

function requireSuccess(result, message) {
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(detail ? `${message} ${detail}` : message);
  }
}

export function resolveManifestPath(target, explicitManifestPath) {
  if (explicitManifestPath) {
    const explicit = path.resolve(explicitManifestPath);
    return isFile(explicit) ? explicit : null;
  }
  if (isFile(target)) {
    return target;
  }
  const candidate = path.join(target, "project-memory.json");
  return isFile(candidate) ? candidate : null;
}

export function resolveConfiguredPath(baseDirectory, configuredPath) {
  return path.isAbsolute(configuredPath)
    ? path.normalize(configuredPath)
    : path.resolve(baseDirectory, configuredPath);
}

export function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new ConnectionError([
      `No se pudo leer ${label} como JSON válido: ${filePath}`,
      error instanceof Error ? error.message : String(error)
    ]);
  }
}

function writeJsonAtomic(filePath, value) {
  writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeTextAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.project-memory-${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function pathEntryExists(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

export class ConnectionError extends Error {
  constructor(details) {
    super(details.join("\n"));
    this.name = "ConnectionError";
    this.details = details;
  }
}
