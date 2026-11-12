import {
  createMemoryConnectionDescriptor,
  copyMemoryConnectionData,
  freezeMemoryConnectionData,
  hasMemoryConnectionKeys,
  memoryConnectionHash,
  MEMORY_CONNECTION_FACTS,
  MEMORY_CONNECTION_LIMITS,
  MEMORY_CONNECTION_VERSION,
  MemoryConnectionInputError
} from "./memory-connection-descriptor.js";
import { containsSensitiveData } from "./sensitive-data.js";

const PIN_KEYS = [
  "manifestSha256", "binSha256", "nodeSha256", "dependenciesSha256",
  "pathMetadataSha256", "skillMetadataSha256"
];
const SERVER_KEYS = ["command", "args", "enabled"];
const SERVER_OPTIONAL = ["cwd", "enabled_tools"];
const HASH = /^[a-f0-9]{64}$/;
const states = (value, allowed) => typeof value === "string" && allowed.includes(value);
const component = (id, action, code) => ({ id, action, code });
const reject = (code) => { throw new MemoryConnectionInputError(code); };
const equal = (a, b) => memoryConnectionHash(a) === memoryConnectionHash(b);

function blank() {
  return {
    command: "project-memory connect plan",
    schemaVersion: MEMORY_CONNECTION_VERSION,
    state: "invalid",
    connectionClass: "unknown",
    identity: null,
    candidateServer: null,
    components: [],
    summary: { create: 0, update: 0, migrate: 0, unchanged: 0, conflicts: 0, blocked: 0 },
    reasons: [],
    planHash: null,
    facts: { ...MEMORY_CONNECTION_FACTS }
  };
}

function finish(report, state, reasons) {
  report.state = state;
  report.reasons = [...new Set(reasons)].sort();
  report.summary = {
    create: report.components.filter((item) => item.action === "create").length,
    update: report.components.filter((item) => item.action === "update").length,
    migrate: report.components.filter((item) => item.action === "migrate").length,
    unchanged: report.components.filter((item) => item.action === "unchanged").length,
    conflicts: report.components.filter((item) => item.action === "conflict").length,
    blocked: report.components.filter((item) => item.action === "blocked").length
  };
  if (!["preview", "unchanged"].includes(state)) {
    report.candidateServer = null;
    report.planHash = null;
  }
  if (Buffer.byteLength(JSON.stringify(report)) > MEMORY_CONNECTION_LIMITS.reportBytes) {
    const limited = blank();
    limited.reasons = ["MC_REPORT_LIMIT"];
    return freezeMemoryConnectionData(limited);
  }
  return freezeMemoryConnectionData(report);
}

function checkObservations(observations) {
  if (!hasMemoryConnectionKeys(observations, ["configuration", "skill"])) {
    reject("MC_OBSERVATIONS_INVALID");
  }
  const config = observations.configuration;
  if (!hasMemoryConnectionKeys(config, ["state", "sha256", "server"]) ||
      !states(config.state, ["absent", "present", "unsafe"])) {
    reject("MC_OBSERVATIONS_INVALID");
  }
  if (config.state === "present") {
    if (typeof config.sha256 !== "string" || !HASH.test(config.sha256) ||
        config.server !== null && (typeof config.server !== "object" || Array.isArray(config.server))) {
      reject("MC_OBSERVATIONS_INVALID");
    }
  } else if (config.sha256 !== null || config.server !== null) {
    reject("MC_OBSERVATIONS_INVALID");
  }
  const skill = observations.skill;
  if (!hasMemoryConnectionKeys(skill, ["state", "resolvedSource"]) ||
      !states(skill.state, ["absent", "matched", "conflict", "unsafe"]) ||
      ["absent", "unsafe"].includes(skill.state) && skill.resolvedSource !== null ||
      skill.state === "matched" && typeof skill.resolvedSource !== "string" ||
      skill.state === "conflict" && skill.resolvedSource !== null && typeof skill.resolvedSource !== "string") {
    reject("MC_OBSERVATIONS_INVALID");
  }
}

function sensitive(value) {
  if (typeof value === "string") return containsSensitiveData(value);
  return value !== null && typeof value === "object" &&
    Object.values(value).some(sensitive);
}

function serverShape(server) {
  return hasMemoryConnectionKeys(server, SERVER_KEYS, SERVER_OPTIONAL) &&
    typeof server.command === "string" && Array.isArray(server.args) &&
    server.args.length <= 16 && server.args.every((arg) => typeof arg === "string") &&
    typeof server.enabled === "boolean" &&
    (server.cwd === undefined || typeof server.cwd === "string") &&
    (server.enabled_tools === undefined || Array.isArray(server.enabled_tools) &&
      server.enabled_tools.every((tool) => typeof tool === "string"));
}

function policyMatches(tools, expected) {
  return Array.isArray(tools) && tools.length === expected.length &&
    new Set(tools).size === tools.length && expected.every((tool) => tools.includes(tool));
}

/**
 * Classifies explicit declarations and creates an intent pin, never a permission.
 * Only these two modules and their tests are part of RG3-A1a: no TOML collector,
 * writer, public CLI dispatch, native MCP test or actual client configuration.
 */
// The exact direct launches `connect` has registered: the first reviewed one and, since nexakit 0.6.0, the
// read-only one. Anything else with the same name stays an identity mismatch.
const LEGACY_DIRECT_LAUNCHES = Object.freeze([
  ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31"],
  ["-y", "@modelcontextprotocol/server-filesystem@2.3.0", "--read-only", "--confine-roots"]
]);

export function createMemoryConnectionPlan(input) {
  const report = blank();
  let data, descriptor;
  try {
    data = copyMemoryConnectionData(input);
    if (!hasMemoryConnectionKeys(data, ["schemaVersion", "descriptor", "observations", "pins", "migrateLegacy"]) ||
        data.schemaVersion !== MEMORY_CONNECTION_VERSION || typeof data.migrateLegacy !== "boolean") {
      reject("MC_PLAN_INVALID");
    }
    if (sensitive(data)) reject("MC_SENSITIVE_INPUT");
    descriptor = createMemoryConnectionDescriptor(data.descriptor?.identity);
    if (!equal(descriptor, data.descriptor)) reject("MC_DESCRIPTOR_MISMATCH");
    if (!hasMemoryConnectionKeys(data.pins, PIN_KEYS) ||
        Object.values(data.pins).some((hash) => typeof hash !== "string" || !HASH.test(hash))) {
      reject("MC_PINS_INVALID");
    }
    checkObservations(data.observations);
    if (data.observations.skill.state === "matched" &&
        data.observations.skill.resolvedSource !== descriptor.skill.source) {
      reject("MC_SKILL_DECLARATION_MISMATCH");
    }
  } catch (error) {
    return finish(report, "invalid", [error instanceof MemoryConnectionInputError ? error.code : "MC_PLAN_INVALID"]);
  }

  report.identity = { ...descriptor.identity };
  const { configuration, skill } = data.observations;
  report.components.push(component("skill", {
    absent: "create", matched: "unchanged", conflict: "conflict", unsafe: "blocked"
  }[skill.state], {
    absent: "MC_SKILL_MISSING", matched: "MC_SKILL_MATCH_DECLARED",
    conflict: "MC_SKILL_CONFLICT", unsafe: "MC_SKILL_UNSAFE"
  }[skill.state]));

  if (configuration.state === "unsafe") {
    report.connectionClass = "unsafe";
    report.components.push(component("mcp", "blocked", "MC_CONFIG_UNSAFE"));
  } else if (configuration.server === null) {
    report.connectionClass = "absent";
    report.components.push(component("mcp", "create", "MC_SERVER_MISSING"),
      component("policy", "create", "MC_POLICY_PROPOSED"));
    report.candidateServer = structuredClone(descriptor.server);
  } else {
    const current = configuration.server;
    if (!serverShape(current)) {
      report.components.push(component("mcp", "conflict", "MC_SERVER_UNKNOWN"));
    } else if (current.command === descriptor.server.command &&
        equal(current.args, descriptor.server.args) && current.cwd === descriptor.server.cwd) {
      report.connectionClass = "protected";
      report.components.push(component("mcp", "unchanged", "MC_SERVER_MATCH_DECLARED"));
      if (policyMatches(current.enabled_tools, descriptor.server.enabled_tools)) {
        report.components.push(component("policy", "unchanged", "MC_POLICY_MATCH_DECLARED"));
        report.candidateServer = { ...structuredClone(descriptor.server), enabled: current.enabled };
      } else {
        report.components.push(component("policy", "conflict", "MC_POLICY_MISMATCH"));
      }
    } else if (current.command === "npx" && LEGACY_DIRECT_LAUNCHES.some(launch =>
      equal(current.args, [...launch, descriptor.identity.vaultPath])) && (current.cwd === undefined || current.cwd === descriptor.server.cwd)) {
      report.connectionClass = "legacy-direct";
      if (data.migrateLegacy) {
        report.components.push(component("mcp", "migrate", "MC_LEGACY_MIGRATION_PROPOSED"),
          component("policy", "migrate", "MC_POLICY_PROPOSED"));
        report.candidateServer = structuredClone(descriptor.server);
      } else {
        report.components.push(component("mcp", "conflict", "MC_LEGACY_OPT_IN_REQUIRED"));
      }
    } else {
      report.components.push(component("mcp", "conflict", "MC_SERVER_IDENTITY_MISMATCH"));
    }
  }

  const reasons = report.components.filter((item) => ["conflict", "blocked"].includes(item.action))
    .map((item) => item.code);
  if (report.components.some((item) => item.action === "blocked")) return finish(report, "blocked", reasons);
  if (report.components.some((item) => item.action === "conflict")) return finish(report, "conflict", reasons);
  try {
    report.planHash = memoryConnectionHash({
      schemaVersion: MEMORY_CONNECTION_VERSION,
      descriptor,
      observations: data.observations,
      pins: data.pins,
      migrateLegacy: data.migrateLegacy,
      components: report.components,
      candidateServer: report.candidateServer
    });
  } catch {
    return finish(report, "invalid", ["MC_PLAN_LIMIT"]);
  }
  const unchanged = report.components.every((item) => item.action === "unchanged");
  const notes = [unchanged ? "MC_MATCH_DECLARED" : "MC_PREVIEW_ONLY"];
  if (report.candidateServer.enabled === false) notes.push("MC_SERVER_DISABLED");
  return finish(report, unchanged ? "unchanged" : "preview", notes);
}
