import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { createMemoryConnectionDescriptor, memoryConnectionHash } from "../src/memory-connection-descriptor.js";
import { validateMemoryConnectionManifest as validate, MEMORY_CONNECTION_MANIFEST_LIMITS as LIMITS } from "../src/memory-connection-manifest.js";

const hash = b => createHash("sha256").update(b).digest("hex");
function fixture(identity = {}) {
  const root = "/fictitious/a1f café 🐦";
  const descriptor = createMemoryConnectionDescriptor({
    agent: "codex", mcpName: "demo-memory", skillName: "demo-skill",
    nodePath: root + "/runtime/node", toolkitRoot: root + "/toolkit",
    vaultPath: root + "/vault", manifestPath: root + "/vault/project-memory.json",
    sourcePath: root + "/source", homeDirectory: root + "/home", ...identity
  });
  const manifest = {
    schemaVersion: "1.0.0", project: { id: "demo-project", name: "Fictitious private-marker" },
    source: { repositoryPath: "../source", defaultBranch: "main" },
    memory: { vaultPath: ".", mcpServerName: "demo-memory", repositoryBranch: "main", syncMode: "none" },
    agents: [{ id: "codex", enabled: true, skillName: "demo-skill" }],
    security: { mcpAccess: "read-only", sensitiveDataPolicy: "forbidden", writeRequiresExplicitAuthorization: true, allowCredentialsInMemory: false }
  };
  const input = (bytes = Buffer.from(JSON.stringify(manifest))) => ({ descriptor, manifestBytes: bytes, expectedManifestSha256: hash(bytes) });
  return { root, descriptor, manifest, input };
}
function facts(r, validated = true) {
  assert.equal(r.facts.evidence, "provided-bytes"); assert.equal(r.facts.verificationScope, "manifest-declarations-only");
  for (const k of ["manifestSchemaValidated", "manifestSecurityValidated", "manifestDescriptorMatched"]) assert.equal(r.facts[k], validated);
  for (const k of ["manifestSemanticsVerified", "physicalPathsVerified", "localReadVerified", "nativeReadVerified", "runtimeVerified", "installedDependenciesVerified", "runtimeVersionVerified", "runtimeCompatibilityVerified", "authorizationGranted", "executable", "applied", "wrote", "sent", "executed"]) assert.equal(r.facts[k], false);
}
function blocked(r, reason, state = "blocked") {
  assert.equal(r.state, state); if (reason) assert.deepEqual(r.reasons, [reason]); facts(r, false);
  assert.equal(r.manifestSha256, null); assert.equal(r.descriptorSha256, null);
  assert.doesNotMatch(JSON.stringify(r), /private-marker|fixture-secret-value|fictitious\/|schema\.invalid|instancePath|schemaPath|stack/);
}
test("A1f valid relative declarations, opaque pin and frozen modest report", () => {
  const f = fixture(), input = f.input(), copy = structuredClone(input), r = validate(input);
  assert.equal(r.state, "validated"); assert.equal(r.manifestSha256, input.expectedManifestSha256);
  assert.equal(r.descriptorSha256, memoryConnectionHash(f.descriptor)); facts(r);
  assert.deepEqual(input.descriptor, copy.descriptor); assert.equal(input.expectedManifestSha256, copy.expectedManifestSha256);
  assert.deepEqual(input.manifestBytes, Buffer.from(copy.manifestBytes));
  assert.equal(Object.isFrozen(input), false); assert.equal(Object.isFrozen(input.manifestBytes), false);
  for (const obj of [r, r.facts, r.reasons]) assert.equal(Object.isFrozen(obj), true);
  assert.throws(() => { r.facts.localReadVerified = true; }, TypeError);
  assert.doesNotMatch(JSON.stringify(r), /private-marker|fictitious/); assert.ok(Buffer.byteLength(JSON.stringify(r)) <= LIMITS.reportBytes);
  input.manifestBytes.fill(0); assert.equal(r.manifestSha256, hash(copy.manifestBytes));
});
for (const representation of ["string", "uint8", "offset-view", "null-prototype", "mutable-descriptor", "CRLF", "spaces", "absolute", "nested-manifest"]) {
  test("A1f valid representation " + representation, () => {
    const f = representation === "nested-manifest" ? fixture({ manifestPath: "/fictitious/a1f café 🐦/vault/config/project-memory.json" }) : fixture();
    if (representation === "absolute") { f.manifest.memory.vaultPath = f.descriptor.identity.vaultPath; f.manifest.source.repositoryPath = f.descriptor.identity.sourcePath; }
    if (representation === "nested-manifest") { f.manifest.memory.vaultPath = ".."; f.manifest.source.repositoryPath = "../../source"; }
    let input = f.input();
    if (representation === "string") input.manifestBytes = input.manifestBytes.toString("utf8");
    if (representation === "uint8") input.manifestBytes = new Uint8Array(input.manifestBytes);
    if (representation === "offset-view") {
      const backing = new Uint8Array(input.manifestBytes.length + 10); backing.set(input.manifestBytes, 5); input.manifestBytes = backing.subarray(5, backing.length - 5);
    }
    if (representation === "null-prototype") input = Object.assign(Object.create(null), input);
    if (representation === "mutable-descriptor") input.descriptor = JSON.parse(JSON.stringify(input.descriptor));
    if (representation === "CRLF") input = f.input(Buffer.from(JSON.stringify(f.manifest, null, 2).replaceAll("\n", "\r\n")));
    if (representation === "spaces") input = f.input(Buffer.from(" \n\t" + JSON.stringify(f.manifest) + "\r\n "));
    assert.equal(validate(input).state, "validated");
    if (representation === "mutable-descriptor") assert.equal(Object.isFrozen(input.descriptor), false);
  });
}
test("A1f closed metadata and hooks are rejected without invocation", () => {
  const f = fixture(), base = f.input(); let calls = 0;
  const bad = [null, undefined, false, [], {}, { ...base, extra: true }, { ...base, toJSON() { calls++; } },
    Object.defineProperty({ ...base }, "manifestBytes", { enumerable: true, get() { calls++; return base.manifestBytes; } }),
    Object.defineProperty({ ...base }, "expectedManifestSha256", { enumerable: true, get() { calls++; } }),
    Object.defineProperty({ ...base }, "descriptor", { enumerable: false, value: base.descriptor }),
    Object.assign(Object.create({}), base), { ...base, [Symbol("metadata")]: 1 },
    new Proxy(base, { ownKeys() { calls++; throw Error("private-marker"); }, get() { calls++; } }),
    { ...base, descriptor: { ...base.descriptor, facts: { ...base.descriptor.facts, authorizationGranted: true } } },
    { ...base, descriptor: { ...base.descriptor, server: { ...base.descriptor.server, command: "/private-marker" } } }];
  for (const key of ["descriptor", "manifestBytes", "expectedManifestSha256"]) { const missing = { ...base }; delete missing[key]; bad.push(missing); }
  for (const pin of [null, 1, "A".repeat(64), "a".repeat(63), "x".repeat(64)]) bad.push({ ...base, expectedManifestSha256: pin });
  const circular = { ...base.descriptor }; circular.extra = circular; bad.push({ ...base, descriptor: circular });
  const hooked = { ...base.descriptor }; Object.defineProperty(hooked, "identity", { enumerable: true, get() { calls++; } }); bad.push({ ...base, descriptor: hooked });
  for (const input of bad) blocked(validate(input), "MC_MANIFEST_INPUT", "invalid"); assert.equal(calls, 0);
});
test("A1f invalid descriptor/pin precede examining the bytes", () => {
  const f = fixture(), base = f.input(); let calls = 0;
  const bytes = new Proxy(base.manifestBytes, { get() { calls++; throw Error("private-marker"); } });
  blocked(validate({ ...base, manifestBytes: bytes, expectedManifestSha256: "wrong" }), "MC_MANIFEST_INPUT", "invalid"); assert.equal(calls, 0);
});
test("A1f unsupported byte types and shared backing fail without hooks", () => {
  const f = fixture(), base = f.input(); let calls = 0;
  class Subclass extends Uint8Array {}
  const bad = [null, undefined, 1, [], new ArrayBuffer(1), new Uint16Array(3), new DataView(new ArrayBuffer(3)), new Subclass(3),
    { toString() { calls++; }, valueOf() { calls++; }, toJSON() { calls++; } },
    new Proxy(base.manifestBytes, { get() { calls++; throw Error("private-marker"); } })];
  if (typeof SharedArrayBuffer === "function") bad.push(new SharedArrayBuffer(3), new Uint8Array(new SharedArrayBuffer(3)), Buffer.from(new SharedArrayBuffer(3)));
  const detached = new Uint8Array(3); structuredClone(detached.buffer, { transfer: [detached.buffer] }); bad.push(detached);
  for (const manifestBytes of bad) blocked(validate({ ...base, manifestBytes }), "MC_MANIFEST_INPUT", "invalid"); assert.equal(calls, 0);
});
test("A1f native byte intrinsics ignore custom getters and iterators", () => {
  const f = fixture(), input = f.input(), view = new Uint8Array(input.manifestBytes); let calls = 0;
  for (const key of ["length", "buffer", "toJSON", "toString"]) Object.defineProperty(view, key, { get() { calls++; throw Error("private-marker"); } });
  Object.defineProperty(view, Symbol.iterator, { get() { calls++; throw Error("private-marker"); } });
  assert.equal(validate({ ...input, manifestBytes: view }).state, "validated"); assert.equal(calls, 0);
});
for (const content of [Buffer.from("not json private-marker"), Buffer.from([0xff]), Buffer.from('{"schemaVersion":"1.0.0","schemaVersion":"wrong"}')]) {
  test("A1f a mismatched pin hides parsing errors before JSON is interpreted " + hash(content).slice(0, 8), () => {
    const f = fixture(), input = f.input(content); input.expectedManifestSha256 = "0".repeat(64);
    const r = validate(input); blocked(r, "MC_MANIFEST_PIN_MISMATCH"); assert.doesNotMatch(JSON.stringify(r), new RegExp(hash(content)));
  });
}
for (const [label, content] of [
  ["empty", ""], ["spaces", " \n\t "], ["array", "[]"], ["null", "null"], ["number", "7"], ["string", '"x"'],
  ["BOM", "\ufeff{}"], ["invalid-utf8", Buffer.from([0xff])], ["truncated-utf8", Buffer.from([0xf0, 0x9f])],
  ["duplicate", '{"x":1,"x":2}'], ["escaped-duplicate", '{"x":1,"\\u0078":2}'],
  ["nested-duplicate", '{"x":{"y":1,"y":2}}'], ["dangerous", '{"__proto__":{}}'], ["constructor", '{"constructor":{}}'],
  ["prototype", '{"prototype":{}}'], ["unpaired-escape", '{"x":"\\ud800"}'], ["unpaired-string", "\ud800"],
  ["comment", "{/* no */}"], ["trailing-comma", '{"x":1,}'], ["two-objects", "{}{}"], ["non-finite", '{"x":1e999}'], ["underflow", '{"x":1e-999}']
]) test("A1f strict JSON blocks " + label, () => {
  const f = fixture(); blocked(validate(f.input(typeof content === "string" && label !== "unpaired-string" ? Buffer.from(content) : content)), "MC_MANIFEST_FORMAT");
});
for (const key of ["schemaVersion", "project", "source", "memory", "agents", "security"]) test("A1f schema requires " + key, () => {
  const f = fixture(); delete f.manifest[key]; blocked(validate(f.input()), "MC_MANIFEST_SCHEMA");
});
for (const [label, modify] of [
  ["unknown-root", m => { m.untrusted = "private-marker"; }], ["unknown-nested", m => { m.memory.extra = true; }],
  ["version", m => { m.schemaVersion = "2.0.0"; }], ["project-type", m => { m.project.name = 1; }],
  ["project-id", m => { m.project.id = "INVALID"; }], ["branch", m => { m.source.defaultBranch = "bad..branch"; }],
  ["sync-mode", m => { m.memory.syncMode = "unknown"; }], ["agent-coercion", m => { m.agents[0].enabled = "true"; }],
  ["read-write", m => { m.security.mcpAccess = "read-write"; }], ["sensitive-allowed", m => { m.security.sensitiveDataPolicy = "allowed"; }],
  ["implicit-write", m => { m.security.writeRequiresExplicitAuthorization = false; }], ["credentials-allowed", m => { m.security.allowCredentialsInMemory = true; }],
  ["automation-no-merged", m => { m.automation = { enabled: true, requiresMergedChange: false }; }],
  ["bad-layout", m => { m.memory.layout = { profile: "unknown" }; }],
  ["areas-unknown-category", m => { m.automation = { enabled: true, requiresMergedChange: true, areas: { inventada: "03-IMPLEMENTACION" } }; }],
  ["areas-path-traversal", m => { m.automation = { enabled: true, requiresMergedChange: true, areas: { documentation: "../fuera" } }; }],
  ["areas-nested-path", m => { m.automation = { enabled: true, requiresMergedChange: true, areas: { tests: "03-IMPLEMENTACION/sub" } }; }],
  ["areas-hidden-directory", m => { m.automation = { enabled: true, requiresMergedChange: true, areas: { tests: ".obsidian" } }; }],
  ["areas-not-string", m => { m.automation = { enabled: true, requiresMergedChange: true, areas: { tests: 3 } }; }]
]) test("A1f schema blocks " + label + " without coercion or removing fields", () => {
  const f = fixture(); modify(f.manifest); const input = f.input(), before = Buffer.from(input.manifestBytes);
  blocked(validate(input), "MC_MANIFEST_SCHEMA"); assert.deepEqual(input.manifestBytes, before);
});
for (const key of ["mcpAccess", "sensitiveDataPolicy", "writeRequiresExplicitAuthorization", "allowCredentialsInMemory"]) test("A1f no security defaults for " + key, () => {
  const f = fixture(); delete f.manifest.security[key]; blocked(validate(f.input()), "MC_MANIFEST_SCHEMA");
});
for (const [label, modify] of [
  ["codex-missing", m => { m.agents = [{ id: "gemini", enabled: true }]; }],
  ["codex-disabled", m => { m.agents[0].enabled = false; }],
  ["skill-missing", m => { delete m.agents[0].skillName; }],
  ["skill-different", m => { m.agents[0].skillName = "other-skill"; }],
  ["codex-duplicate", m => { m.agents.push({ id: "codex", enabled: false }); }],
  ["other-agent-duplicate", m => { m.agents.push({ id: "gemini", enabled: false }, { id: "gemini", enabled: true }); }]
]) test("A1f rejects ambiguous or contradictory agents " + label, () => {
  const f = fixture(); modify(f.manifest); blocked(validate(f.input()), "MC_MANIFEST_AGENTS");
});
for (const value of ["other-memory", "demo-memory-other"]) test("A1f MCP name must match " + value, () => {
  const f = fixture(); f.manifest.memory.mcpServerName = value; blocked(validate(f.input()), "MC_MANIFEST_IDENTITY");
});
for (const value of ["../other", " ../source", "../source ", "../source/", "../source//", "C:/source", "file:/source", "https://source.invalid", "../sou\\rce", "../.git/../source", "../.env/../source", "../credentials/../source", "../source\u0000", "../source\u202e", "/", "/fictitious/../source"]) {
  test("A1f source path rejects unsafe or different declaration " + JSON.stringify(value), () => {
    const f = fixture(); f.manifest.source.repositoryPath = value; blocked(validate(f.input()), "MC_MANIFEST_IDENTITY");
  });
}
for (const value of ["../other", "..", "./.obsidian/..", "./.agents/..", "//vault", "./vault\\other", " ", "./.", "../vault/"]) {
  test("A1f vault path declaration " + JSON.stringify(value), () => {
    const f = fixture(); f.manifest.memory.vaultPath = value;
    if (value === "./.") assert.equal(validate(f.input()).state, "validated"); else blocked(validate(f.input()), "MC_MANIFEST_IDENTITY");
  });
}
for (const delta of [{ toolkitRoot: "/fictitious/a1f café 🐦/vault/toolkit" }, { manifestPath: "/fictitious/a1f café 🐦/outside.json" }]) {
  test("A1f descriptor must fit A1e root layout " + Object.keys(delta)[0], () => {
    const f = fixture(delta); blocked(validate(f.input()), "MC_MANIFEST_INPUT", "invalid");
  });
}
test("A1f lexical final path component and character limits without filesystem lookup", () => {
  const base = "/" + Array(65).fill("d").join("/");
  const f = fixture({ sourcePath: base }); f.manifest.source.repositoryPath = base; blocked(validate(f.input()), "MC_MANIFEST_IDENTITY");
  const long = fixture({ manifestPath: "/fictitious/a1f café 🐦/vault/deep/project-memory.json" });
  long.manifest.source.repositoryPath = "x".repeat(4096); blocked(validate(long.input()), "MC_MANIFEST_IDENTITY");
});
test("A1f external schema, remote, layout, automation and extra agents remain declarations", () => {
  const f = fixture(); f.manifest.$schema = "https://schema.invalid/never-fetch.json";
  f.manifest.source.remoteUrl = "https://repository.invalid/demo";
  f.manifest.memory.repositoryRemote = "https://memory.invalid/demo";
  f.manifest.memory.layout = { profile: "declared", requiredDirectories: ["missing-directory"], requiredNotes: ["missing-note.md"] };
  f.manifest.automation = { enabled: true, requiresMergedChange: true, schedule: "never-execute", reviewBranch: "main" };
  f.manifest.agents.push({ id: "claude", enabled: true, skillName: "different-skill" }, { id: "gemini", enabled: true });
  const r = validate(f.input()); assert.equal(r.state, "validated"); facts(r); assert.doesNotMatch(JSON.stringify(r), /never-|missing-|different-skill|repository\.invalid/);
});
for (const where of ["name", "remote", "description", "schema-url"]) test("A1f sensitive-value heuristic blocks without exposing values " + where, () => {
  const f = fixture();
  if (where === "name") f.manifest.project.name = ["ghp", "_"].join("") + "a".repeat(40);
  if (where === "description") f.manifest.project.description = ["api", "_key=fixture-secret-value"].join("");
  if (where === "remote") f.manifest.source.remoteUrl = ["https://user", ":", "fixture-secret-value", "@repository.invalid/demo"].join("");
  if (where === "schema-url") f.manifest.$schema = "https://schema.invalid?" + ["access", "_token=fixture-secret-value"].join("");
  blocked(validate(f.input()), "MC_MANIFEST_SENSITIVE");
});
test("A1f byte limit exact in Buffer/string and no full JSON materialization before a pin mismatch", () => {
  const f = fixture(), body = JSON.stringify(f.manifest), bodyBytes = Buffer.byteLength(body);
  const text = body + " ".repeat(LIMITS.manifestBytes - bodyBytes), bytes = Buffer.from(text);
  assert.equal(bytes.length, LIMITS.manifestBytes);
  assert.equal(validate(f.input(bytes)).state, "validated"); assert.equal(validate(f.input(text)).state, "validated");
  blocked(validate(f.input(Buffer.concat([bytes, Buffer.from(" ")]))), "MC_MANIFEST_LIMIT");
  blocked(validate(f.input(text + " ")), "MC_MANIFEST_LIMIT");
  const mismatch = f.input(bytes); mismatch.expectedManifestSha256 = "0".repeat(64); blocked(validate(mismatch), "MC_MANIFEST_PIN_MISMATCH");
});
test("A1f UTF-8 byte count, not string length, controls cap", () => {
  const f = fixture(), text = "é".repeat(LIMITS.manifestBytes / 2 + 1);
  assert.ok(text.length < LIMITS.manifestBytes); blocked(validate(f.input(text)), "MC_MANIFEST_LIMIT");
});
for (const size of [256, 257]) test("A1f array bound " + size + " before schema", () => {
  const f = fixture(); f.manifest.agents.push(...Array.from({ length: size - 1 }, (_, i) => ({ id: "agent" + i, enabled: false })));
  if (size === 256) assert.equal(validate(f.input()).state, "validated"); else blocked(validate(f.input()), "MC_MANIFEST_LIMIT");
});
for (const depth of [64, 65]) test("A1f depth bound " + depth + " before schema", () => {
  const f = fixture(); let value = 0; for (let i = 1; i < depth; i++) value = { x: value }; f.manifest.unknown = value;
  blocked(validate(f.input()), depth === 64 ? "MC_MANIFEST_SCHEMA" : "MC_MANIFEST_LIMIT");
});
for (const width of [110, 120]) test("A1f node bound before schema " + width, () => {
  const f = fixture(); f.manifest.unknown = Array.from({ length: 256 }, () => Array(width).fill(0));
  assert.ok(f.input().manifestBytes.length < LIMITS.manifestBytes);
  blocked(validate(f.input()), width === 110 ? "MC_MANIFEST_SCHEMA" : "MC_MANIFEST_LIMIT");
});
test("A1f evaluation performs no filesystem, discovery, network, process or environment access", () => {
  const f = fixture(), input = f.input(), restore = []; let calls = 0;
  const deny = () => { calls++; throw Error("private-marker"); };
  const replace = (obj, key) => { const original = obj[key]; obj[key] = deny; restore.push(() => { obj[key] = original; }); };
  for (const key of ["readFile", "lstat", "stat", "open", "realpath", "readdir", "writeFile", "mkdir", "rm", "rename", "chmod"]) replace(fsp, key);
  for (const key of ["readFileSync", "lstatSync", "statSync", "openSync", "realpathSync", "readdirSync", "writeFileSync", "mkdirSync", "rmSync"]) replace(fs, key);
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) replace(childProcess, key);
  for (const obj of [http, https]) for (const key of ["request", "get"]) replace(obj, key);
  for (const key of ["connect", "createConnection"]) replace(net, key);
  replace(globalThis, "fetch"); replace(process, "cwd"); replace(os, "homedir");
  const originalEnv = process.env; process.env = new Proxy(originalEnv, { get: deny, ownKeys: deny }); restore.push(() => { process.env = originalEnv; });
  let result; try { result = validate(input); } finally { for (const fn of restore.reverse()) fn(); }
  assert.equal(result.state, "validated"); facts(result); assert.equal(calls, 0);
});

test("A1f automation.areas acepta carpetas de primer nivel por categoría", () => {
  const f = fixture();
  f.manifest.automation = { enabled: true, requiresMergedChange: true, reviewBranch: "main", areas: { documentation: "03-IMPLEMENTACION", tests: "03-IMPLEMENTACION", implementation: "03-IMPLEMENTACION" } };
  const r = validate(f.input()); assert.equal(r.state, "validated");
});
