import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import childProcess from "node:child_process";

import { createMemoryConnectionDescriptor, MEMORY_CONNECTION_FACTS, MEMORY_CONNECTION_LIMITS } from "../src/memory-connection-descriptor.js";
import { createMemoryConnectionPlan } from "../src/memory-connection-plan.js";

const PIN_KEYS = ["manifestSha256", "binSha256", "nodeSha256", "dependenciesSha256", "pathMetadataSha256", "skillMetadataSha256"];
const descriptor = () => createMemoryConnectionDescriptor({
  agent: "codex", mcpName: "demo-memory", skillName: "demo",
  nodePath: "/fictitious/runtime/node", toolkitRoot: "/fictitious/toolkit",
  manifestPath: "/fictitious/memory/project-memory.json",
  vaultPath: "/fictitious/memory", sourcePath: "/fictitious/source",
  homeDirectory: "/fictitious/home"
});
const fixture = () => ({
  schemaVersion: "1.0.0", descriptor: descriptor(), migrateLegacy: false,
  observations: {
    configuration: { state: "absent", sha256: null, server: null },
    skill: { state: "absent", resolvedSource: null }
  },
  pins: Object.fromEntries(PIN_KEYS.map((key, i) => [key, String(i + 1).repeat(64)]))
});
const protectedFixture = (enabled = true) => {
  const input = fixture();
  input.observations.configuration = {
    state: "present", sha256: "a".repeat(64),
    server: { ...structuredClone(input.descriptor.server), enabled }
  };
  input.observations.skill = { state: "matched", resolvedSource: input.descriptor.skill.source };
  return input;
};
const legacyFixture = () => {
  const input = protectedFixture();
  input.observations.configuration.server = {
    command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem@2026.8.31", "/fictitious/memory"], enabled: true
  };
  return input;
};
test("the direct read-only server that connect registers since 2.3.0 is also a legacy-direct connection; other launches are not", () => {
  const direct = args => { const input = legacyFixture(); input.observations.configuration.server.args = args; return createMemoryConnectionPlan(input); };
  const pkg = "@modelcontextprotocol/server-filesystem";
  assert.equal(direct(["-y", pkg + "@2.3.0", "--read-only", "--confine-roots", "/fictitious/memory"]).connectionClass, "legacy-direct");
  for (const args of [["-y", pkg + "@2.3.0", "/fictitious/memory"], ["-y", pkg + "@2.3.0", "--read-only", "--confine-roots", "/other"],
    ["-y", pkg + "@9.9.9", "--read-only", "--confine-roots", "/fictitious/memory"], ["-y", pkg + "@2.3.0", "--read-only", "--confine-roots", "/fictitious/memory", "/other"]])
    assert.notEqual(direct(args).connectionClass, "legacy-direct", args.join(" "));
});
const checkFacts = (result) => {
  assert.deepEqual(result.facts, MEMORY_CONNECTION_FACTS);
  assert.equal(result.facts.evidence, "declared");
  for (const key of ["localReadVerified", "nativeReadVerified", "physicalPathsVerified", "runtimeVerified", "authorizationGranted", "executable", "wrote", "sent", "executed", "applied"]) {
    assert.equal(result.facts[key], false);
  }
};

test("MC plan proposes three components for an absent declared installation", () => {
  const result = createMemoryConnectionPlan(fixture());
  assert.equal(result.state, "preview");
  assert.equal(result.connectionClass, "absent");
  assert.deepEqual(result.summary, { create: 3, update: 0, migrate: 0, unchanged: 0, conflicts: 0, blocked: 0 });
  assert.match(result.planHash, /^[a-f0-9]{64}$/);
  assert.equal(result.candidateServer.enabled, false);
  assert.deepEqual(result.reasons, ["MC_PREVIEW_ONLY", "MC_SERVER_DISABLED"]);
  checkFacts(result);
});

test("MC plan handles an absent slot in an existing declared config without echoing that config", () => {
  const input = fixture();
  input.observations.configuration = { state: "present", sha256: "a".repeat(64), server: null };
  const result = createMemoryConnectionPlan(input);
  assert.equal(result.state, "preview");
  assert.equal(result.connectionClass, "absent");
  assert.notEqual(result.planHash, createMemoryConnectionPlan(fixture()).planHash);
  assert.equal(Object.hasOwn(result, "configuration"), false);
});

for (const enabled of [true, false]) {
  test("MC protected declared tuple is unchanged with enabled=" + enabled, () => {
    const result = createMemoryConnectionPlan(protectedFixture(enabled));
    assert.equal(result.state, "unchanged");
    assert.equal(result.connectionClass, "protected");
    assert.equal(result.summary.unchanged, 3);
    assert.equal(result.candidateServer.enabled, enabled);
    assert.equal(result.reasons.includes("MC_SERVER_DISABLED"), !enabled);
    checkFacts(result);
  });
}
test("MC protected policy is an exact set, independent of order", () => {
  const input = protectedFixture();
  input.observations.configuration.server.enabled_tools.reverse();
  const result = createMemoryConnectionPlan(input);
  assert.equal(result.state, "unchanged");
  assert.deepEqual(result.candidateServer.enabled_tools, input.descriptor.server.enabled_tools);
});

for (const kind of ["missing", "short", "extra", "duplicate", "wrong-type"]) {
  test("MC protected policy mismatch " + kind + " cannot be repaired implicitly", () => {
    const input = protectedFixture(); input.migrateLegacy = true;
    const server = input.observations.configuration.server;
    if (kind === "missing") delete server.enabled_tools;
    if (kind === "short") server.enabled_tools.pop();
    if (kind === "extra") server.enabled_tools.push("write_file");
    if (kind === "duplicate") server.enabled_tools[0] = server.enabled_tools[1];
    if (kind === "wrong-type") server.enabled_tools = "read_text_file";
    const result = createMemoryConnectionPlan(input);
    assert.equal(result.state, "conflict");
    assert.equal(result.planHash, null);
    assert.equal(result.candidateServer, null);
    checkFacts(result);
  });
}

test("MC exact legacy is a conflict without migration opt-in", () => {
  const result = createMemoryConnectionPlan(legacyFixture());
  assert.equal(result.state, "conflict");
  assert.equal(result.connectionClass, "legacy-direct");
  assert.ok(result.reasons.includes("MC_LEGACY_OPT_IN_REQUIRED"));
  assert.equal(result.planHash, null);
  assert.equal(result.candidateServer, null);
});
test("MC exact legacy opt-in proposes migration and disabled target, not permission", () => {
  const input = legacyFixture(); input.migrateLegacy = true;
  const result = createMemoryConnectionPlan(input);
  assert.equal(result.state, "preview");
  assert.equal(result.connectionClass, "legacy-direct");
  assert.equal(result.summary.migrate, 2);
  assert.equal(result.summary.unchanged, 1);
  assert.equal(result.candidateServer.enabled, false);
  assert.equal(result.candidateServer.command, input.descriptor.server.command);
  assert.match(result.planHash, /^[a-f0-9]{64}$/);
  checkFacts(result);
});
test("MC legacy weak policy is replaced only in the explicitly proposed migration", () => {
  const input = legacyFixture(); input.migrateLegacy = true;
  input.observations.configuration.server.enabled_tools = ["write_file"];
  const result = createMemoryConnectionPlan(input);
  assert.equal(result.state, "preview");
  assert.deepEqual(result.candidateServer.enabled_tools, input.descriptor.server.enabled_tools);
  assert.equal(result.summary.migrate, 2);
});

for (const kind of ["unversioned", "other-version", "other-vault", "additional-root", "shell", "env", "other-cwd", "missing-enabled", "extra-setting"]) {
  test("MC legacy rejects ambiguous migration " + kind, () => {
    const input = legacyFixture(); input.migrateLegacy = true;
    const server = input.observations.configuration.server;
    if (kind === "unversioned") server.args[1] = "@modelcontextprotocol/server-filesystem";
    if (kind === "other-version") server.args[1] = "@modelcontextprotocol/server-filesystem@1.0.0";
    if (kind === "other-vault") server.args[2] = "/fictitious/other-memory";
    if (kind === "additional-root") server.args.push("/fictitious/other-memory");
    if (kind === "shell") { server.command = "sh"; server.args = ["-c", "fictitious command"]; }
    if (kind === "env") server.env = { A: "fictitious" };
    if (kind === "other-cwd") server.cwd = "/fictitious/other-toolkit";
    if (kind === "missing-enabled") delete server.enabled;
    if (kind === "extra-setting") server.startup_timeout_sec = 123;
    const result = createMemoryConnectionPlan(input);
    assert.equal(result.state, "conflict");
    assert.equal(result.candidateServer, null);
    assert.equal(result.planHash, null);
  });
}
test("MC legacy with the explicitly expected cwd can be proposed", () => {
  const input = legacyFixture(); input.migrateLegacy = true;
  input.observations.configuration.server.cwd = input.descriptor.server.cwd;
  assert.equal(createMemoryConnectionPlan(input).state, "preview");
});

for (const kind of ["command", "bin", "manifest", "arg-count", "cwd", "env"]) {
  test("MC protected identity mismatch " + kind + " is not adopted", () => {
    const input = protectedFixture();
    const server = input.observations.configuration.server;
    if (kind === "command") server.command = "/fictitious/other-node";
    if (kind === "bin") server.args[0] = "/fictitious/other-bin.js";
    if (kind === "manifest") server.args[2] = "/fictitious/other-manifest.json";
    if (kind === "arg-count") server.args.push("--fictitious-extra");
    if (kind === "cwd") server.cwd = "/fictitious/other-toolkit";
    if (kind === "env") server.env = { A: "fictitious" };
    const result = createMemoryConnectionPlan(input);
    assert.equal(result.state, "conflict");
    assert.equal(result.candidateServer, null);
    assert.equal(result.planHash, null);
  });
}
test("MC absent Skill on matched MCP is a preview, not unchanged", () => {
  const input = protectedFixture();
  input.observations.skill = { state: "absent", resolvedSource: null };
  const result = createMemoryConnectionPlan(input);
  assert.equal(result.state, "preview");
  assert.equal(result.summary.create, 1);
  assert.equal(result.summary.unchanged, 2);
});
test("MC conflicting Skill cancels every proposed component", () => {
  const input = fixture();
  input.observations.skill = { state: "conflict", resolvedSource: "/fictitious/other-skill" };
  const result = createMemoryConnectionPlan(input);
  assert.equal(result.state, "conflict");
  assert.ok(result.reasons.includes("MC_SKILL_CONFLICT"));
  assert.equal(result.candidateServer, null);
  assert.equal(result.planHash, null);
  assert.equal(JSON.stringify(result).includes("other-skill"), false);
});
test("MC broken or non-link Skill can declare conflict without a resolved source", () => {
  const input = fixture();
  input.observations.skill = { state: "conflict", resolvedSource: null };
  const result = createMemoryConnectionPlan(input);
  assert.equal(result.state, "conflict");
  assert.deepEqual(result.reasons, ["MC_SKILL_CONFLICT"]);
  assert.equal(result.planHash, null);
});
for (const component of ["configuration", "skill"]) {
  test("MC unsafe declared " + component + " blocks before proposing actions", () => {
    const input = protectedFixture();
    if (component === "configuration") input.observations.configuration = { state: "unsafe", sha256: null, server: null };
    else input.observations.skill = { state: "unsafe", resolvedSource: null };
    const result = createMemoryConnectionPlan(input);
    assert.equal(result.state, "blocked");
    assert.equal(result.summary.blocked, 1);
    assert.equal(result.planHash, null);
    assert.equal(result.candidateServer, null);
    checkFacts(result);
  });
}
test("MC blocked takes precedence without concealing a separate Skill conflict", () => {
  const input = fixture();
  input.observations.configuration = { state: "unsafe", sha256: null, server: null };
  input.observations.skill = { state: "conflict", resolvedSource: "/fictitious/other-skill" };
  const result = createMemoryConnectionPlan(input);
  assert.equal(result.state, "blocked");
  assert.deepEqual(result.reasons, ["MC_CONFIG_UNSAFE", "MC_SKILL_CONFLICT"]);
});

for (const key of PIN_KEYS) {
  test("MC plan requires declared pin " + key, () => {
    const input = fixture(); delete input.pins[key];
    const result = createMemoryConnectionPlan(input);
    assert.equal(result.state, "invalid");
    assert.deepEqual(result.reasons, ["MC_PINS_INVALID"]);
  });
  test("MC pin changes when declared " + key + " changes", () => {
    const input = fixture(), previous = createMemoryConnectionPlan(input).planHash;
    input.pins[key] = "f".repeat(64);
    assert.notEqual(createMemoryConnectionPlan(input).planHash, previous);
  });
}
for (const hash of [null, 123, "A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
  test("MC plan rejects malformed declared hash " + String(hash).slice(0, 16), () => {
    const input = fixture(); input.pins.binSha256 = hash;
    assert.deepEqual(createMemoryConnectionPlan(input).reasons, ["MC_PINS_INVALID"]);
  });
}
test("MC configuration byte pin is bound to the proposed plan", () => {
  const input = protectedFixture(), previous = createMemoryConnectionPlan(input).planHash;
  input.observations.configuration.sha256 = "b".repeat(64);
  assert.notEqual(createMemoryConnectionPlan(input).planHash, previous);
});
test("MC plan pin binds the explicit migration flag even for an exact protected declaration", () => {
  const input = protectedFixture(), previous = createMemoryConnectionPlan(input).planHash;
  input.migrateLegacy = true;
  assert.notEqual(createMemoryConnectionPlan(input).planHash, previous);
});
test("MC plan pin binds changed desired identity", () => {
  const input = fixture(), previous = createMemoryConnectionPlan(input).planHash;
  input.descriptor = createMemoryConnectionDescriptor({ ...input.descriptor.identity, mcpName: "other-memory" });
  assert.notEqual(createMemoryConnectionPlan(input).planHash, previous);
});
test("MC plan is deterministic across insertion order and repeated calls", () => {
  const input = fixture(), before = structuredClone(input);
  const reversed = Object.fromEntries(Object.entries(input).reverse());
  reversed.pins = Object.fromEntries(Object.entries(input.pins).reverse());
  assert.deepEqual(createMemoryConnectionPlan(input), createMemoryConnectionPlan(reversed));
  assert.deepEqual(createMemoryConnectionPlan(input), createMemoryConnectionPlan(input));
  assert.deepEqual(input, before);
});

for (const kind of ["enabled", "command", "tools", "facts", "extra"]) {
  test("MC caller cannot forge canonical descriptor " + kind, () => {
    const input = fixture(); input.descriptor = structuredClone(input.descriptor);
    if (kind === "enabled") input.descriptor.server.enabled = true;
    if (kind === "command") input.descriptor.server.command = "arbitrary";
    if (kind === "tools") input.descriptor.server.enabled_tools.push("write_file");
    if (kind === "facts") input.descriptor.facts.nativeReadVerified = true;
    if (kind === "extra") input.descriptor.permission = "approved";
    const result = createMemoryConnectionPlan(input);
    assert.equal(result.state, "invalid");
    assert.deepEqual(result.reasons, ["MC_DESCRIPTOR_MISMATCH"]);
    assert.equal(result.identity, null);
    checkFacts(result);
  });
}
for (const kind of ["extra", "version", "migration-type", "configuration-state", "missing-config-hash", "absent-with-server", "matched-skill-wrong-source", "skill-state", "pin-extra"]) {
  test("MC closed packet rejects inconsistent observation " + kind, () => {
    const input = protectedFixture();
    if (kind === "extra") input.authorization = true;
    if (kind === "version") input.schemaVersion = "2.0.0";
    if (kind === "migration-type") input.migrateLegacy = "true";
    if (kind === "configuration-state") input.observations.configuration.state = "verified";
    if (kind === "missing-config-hash") input.observations.configuration.sha256 = null;
    if (kind === "absent-with-server") input.observations.configuration.state = "absent";
    if (kind === "matched-skill-wrong-source") input.observations.skill.resolvedSource = "/fictitious/other-skill";
    if (kind === "skill-state") input.observations.skill.state = "approved";
    if (kind === "pin-extra") input.pins.extra = "a".repeat(64);
    const result = createMemoryConnectionPlan(input);
    assert.equal(result.state, "invalid");
    assert.equal(result.identity, null);
    assert.equal(result.planHash, null);
    checkFacts(result);
  });
}
test("MC plan errors do not invoke conversion hooks or return their content", () => {
  let calls = 0;
  const input = fixture();
  Object.defineProperty(input, "migrateLegacy", { enumerable: true, get() { calls++; throw Error("FICTITIOUS_UPSTREAM_DIAGNOSTIC"); } });
  const result = createMemoryConnectionPlan(input);
  assert.equal(result.state, "invalid");
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(result).includes("FICTITIOUS_UPSTREAM_DIAGNOSTIC"), false);
  checkFacts(result);
});
test("MC proxy trap, toJSON, cycles and non-enumerable fields are rejected inertly", () => {
  let calls = 0;
  const proxy = new Proxy(fixture(), { ownKeys() { calls++; throw Error(); } });
  const hook = { ...fixture(), toJSON() { calls++; throw Error(); } };
  const cycle = fixture(); cycle.self = cycle;
  const hidden = fixture(); Object.defineProperty(hidden, "hidden", { value: true });
  for (const input of [proxy, hook, cycle, hidden]) {
    assert.equal(createMemoryConnectionPlan(input).state, "invalid");
  }
  assert.equal(calls, 0);
});
test("MC high-confidence sensitive declaration is not retained in report or pin", () => {
  const input = protectedFixture();
  const marker = "password=" + "fictitious-sensitive-sentinel";
  input.observations.configuration.server.command = marker;
  const result = createMemoryConnectionPlan(input);
  assert.equal(result.state, "invalid");
  assert.deepEqual(result.reasons, ["MC_SENSITIVE_INPUT"]);
  assert.equal(result.planHash, null);
  assert.equal(JSON.stringify(result).includes(marker), false);
});
test("MC unknown private observation fields are not forwarded", () => {
  const input = fixture();
  input.observations.rawError = "FICTITIOUS_PRIVATE_DIAGNOSTIC";
  const result = createMemoryConnectionPlan(input);
  assert.equal(result.state, "invalid");
  assert.equal(JSON.stringify(result).includes("FICTITIOUS_PRIVATE_DIAGNOSTIC"), false);
});
test("MC unknown server entry is a conflict without echoing unrelated values", () => {
  const input = protectedFixture();
  input.observations.configuration.server.extraSetting = "FICTITIOUS_UNRELATED_SETTING";
  const result = createMemoryConnectionPlan(input);
  assert.equal(result.state, "conflict");
  assert.deepEqual(result.reasons, ["MC_SERVER_UNKNOWN"]);
  assert.equal(JSON.stringify(result).includes("FICTITIOUS_UNRELATED_SETTING"), false);
  assert.equal(result.planHash, null);
});
test("MC inert null-prototype packet remains a declaration, not native provenance", () => {
  const input = fixture();
  const inert = Object.assign(Object.create(null), input);
  assert.deepEqual(createMemoryConnectionPlan(inert), createMemoryConnectionPlan(input));
  checkFacts(createMemoryConnectionPlan(inert));
});
test("MC input limits fail without echoing oversized data", () => {
  const input = fixture(); input.extra = "x".repeat(140000);
  const result = createMemoryConnectionPlan(input);
  assert.equal(result.state, "invalid");
  assert.deepEqual(result.reasons, ["MC_INPUT_LIMIT"]);
  assert.ok(JSON.stringify(result).length < 2000);
});
test("MC a bounded input whose expanded pin exceeds budget fails closed without throwing", () => {
  const input = legacyFixture(); input.migrateLegacy = true;
  input.observations.configuration.server.enabled_tools = [""];
  const padding = MEMORY_CONNECTION_LIMITS.inputBytes - Buffer.byteLength(JSON.stringify(input)) - 1;
  assert.ok(padding > 0);
  input.observations.configuration.server.enabled_tools[0] = "x".repeat(padding);
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < MEMORY_CONNECTION_LIMITS.inputBytes);
  let result;
  assert.doesNotThrow(() => { result = createMemoryConnectionPlan(input); });
  assert.equal(result.state, "invalid");
  assert.deepEqual(result.reasons, ["MC_PLAN_LIMIT"]);
  assert.equal(result.planHash, null);
  assert.equal(result.candidateServer, null);
  checkFacts(result);
});
test("MC report owns nested data and never freezes caller observations", () => {
  const input = protectedFixture(), before = structuredClone(input);
  const result = createMemoryConnectionPlan(input);
  assert.deepEqual(input, before);
  assert.equal(Object.isFrozen(input.observations), false);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.components[0]));
  assert.ok(Object.isFrozen(result.candidateServer.args) && Object.isFrozen(result.facts));
  input.observations.configuration.server.enabled_tools.push("fictitious-later");
  assert.equal(result.candidateServer.enabled_tools.includes("fictitious-later"), false);
  assert.throws(() => result.components.push({}), TypeError);
});
test("MC no inputs cause exceptions or supply runtime admission", () => {
  for (const input of [undefined, null, true, 12, "fixture", [], new Date(), new Map()]) {
    const result = createMemoryConnectionPlan(input);
    assert.equal(result.state, "invalid");
    checkFacts(result);
  }
});

test("MC plan invokes no discovery, IO, process, network or clock APIs", () => {
  const input = protectedFixture(), saved = []; let calls = 0; let result;
  const patches = [
    [process, "cwd"], [os, "homedir"], [Date, "now"],
    [fs, "readFileSync"], [fs, "writeFileSync"], [fs, "realpathSync"],
    [fsp, "readFile"], [fsp, "writeFile"], [fsp, "lstat"], [fsp, "open"],
    [childProcess, "spawn"], [childProcess, "spawnSync"], [childProcess, "execFileSync"],
    [http, "request"], [https, "request"], [globalThis, "fetch"]
  ];
  try {
    for (const [object, key] of patches) {
      saved.push([object, key, object[key]]);
      object[key] = () => { calls++; throw Error("pure function crossed IO boundary"); };
    }
    result = createMemoryConnectionPlan(input);
  } finally {
    for (const [object, key, value] of saved) object[key] = value;
  }
  assert.equal(calls, 0);
  assert.equal(result.state, "unchanged");
  checkFacts(result);
});

test("MC new modules are not wired into existing public entrypoints", () => {
  for (const file of ["connect.js", "status.js", "cli.js"]) {
    const source = fs.readFileSync(new URL("../src/" + file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /memory-connection-(?:descriptor|plan)/);
  }
});
