import { compiler, sdkArguments, supported } from "../testing/client-posix.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { createManagedPreferencesReader, createManagedPreferencesStreamReader, PREFERENCE_KEYS, PREFERENCES_SCHEMA_ID } from "../src/client-managed-preferences.js";

const schema = JSON.parse(await fs.readFile(new URL("../schemas/agent-client-managed-preferences.schema.json", import.meta.url), "utf8"));
const read = createManagedPreferencesReader(schema, "synthetic");
function wire() { return { schemaVersion: "1.0.0", source: "synthetic", application: "com.anthropic.claudecode", status: "complete",
  fields: PREFERENCE_KEYS.map(name => ({ name, type: "not-found-by-api", forced: "not-forced" })) }; }
function safe(r) {
  assert.equal(r.scope, "partial-preference-observation"); assert.equal(r.decision, "no-native-start");
  for (const key of ["helperExecutionVerified", "preferencesQueriedVerified", "runtimeReady", "verifiedAdmission", "effectiveIsolationVerified", "externalBillingVerified"]) assert.equal(r[key], false);
  assert.deepEqual(Object.keys(r).sort(), ["scope", "state", "decision", "sourceClaim", "fields", "reasons", "helperExecutionVerified", "preferencesQueriedVerified", "runtimeReady", "verifiedAdmission", "effectiveIsolationVerified", "externalBillingVerified"].sort());
  if (r.state !== "partial-observation") assert.deepEqual(r.fields, []);
  else assert.deepEqual(r.fields.map(f => f.name), PREFERENCE_KEYS);
  assert.doesNotMatch(JSON.stringify(r), /synthetic-private|example\.invalid|\/Users\/|argv|permission|token|command/i);
  return r;
}
test("NP protocol validation is not proof of query, absence, execution or isolation", () => {
  const r = safe(read(wire(), 0)); assert.equal(r.state, "partial-observation");
  assert.ok(r.fields.every(f => f.type === "not-found-by-api" && f.forced === "not-forced"));
  assert.deepEqual(r.reasons, ["preferences-observation-partial"]);
});
test("NP encodings, canonical key order and immutable inputs/schema", () => {
  const d = wire(), before = structuredClone(d), s = structuredClone(schema), r = read(d, 0);
  assert.deepEqual(read(JSON.stringify(d), 0), r); assert.deepEqual(read(Buffer.from(JSON.stringify(d)), 0), r);
  assert.deepEqual(read(new Uint8Array(Buffer.from(JSON.stringify(d))), 0), r);
  d.fields.reverse(); assert.deepEqual(read(d, 0), r); d.fields.reverse();
  assert.deepEqual(d, before); assert.deepEqual(schema, s); r.fields[0].type = "string"; assert.deepEqual(read(d, 0), read(before, 0));
});
test("NP reader snapshots schema, not a mutable caller reference", () => {
  const s = structuredClone(schema), p = createManagedPreferencesReader(s, "synthetic"); s.$defs.wire.oneOf[0].additionalProperties = true;
  const d = wire(); d.extra = "synthetic-private"; assert.equal(p(d, 0).state, "invalid"); assert.ok(Object.isFrozen(PREFERENCE_KEYS));
});
for (const name of PREFERENCE_KEYS) for (const type of ["boolean", "number", "string", "array", "dictionary", "other", "not-found-by-api"]) test(`NP ${name} ${type} never copies a value`, () => {
  const d = wire(); d.fields.find(f => f.name === name).type = type; assert.equal(safe(read(d, 0)).state, "partial-observation");
});
for (const name of PREFERENCE_KEYS) for (const forced of ["forced", "not-forced", "unknown"]) test(`NP ${name} ${forced} is not a presence or permission verdict`, () => {
  const d = wire(); d.fields.find(f => f.name === name).forced = forced; const r = safe(read(d, 0)); assert.equal(r.state, "partial-observation");
  if (forced === "forced") assert.ok(r.reasons.includes("preferences-nonatomic-observation"));
  if (forced === "unknown") assert.ok(r.reasons.includes("preferences-force-unknown"));
});
for (const code of ["preferences-arguments-rejected", "preferences-backend-failed", "preferences-type-rejected"]) test("NP closed helper failure " + code, () => {
  const d = { schemaVersion: "1.0.0", source: "synthetic", status: "failed", code };
  const r = safe(read(d, 1)); assert.equal(r.state, "helper-failed"); assert.deepEqual(r.reasons, [code]);
  assert.equal(read(d, 0).state, "invalid");
});
for (const code of [undefined, null, "0", true, -1, 1, 2, 0.5, NaN, Infinity]) test("NP rejects incompatible or coerced exit status", () => assert.equal(safe(read(wire(), code)).state, "invalid"));
test("NP core-foundation marker is a claim, not a trusted execution", () => {
  const d = wire(); d.source = "core-foundation-claim"; assert.equal(read(d, 0).state, "invalid");
  assert.equal(safe(createManagedPreferencesReader(schema, "core-foundation-claim")(d, 0)).state, "partial-observation");
});
for (const [name, mutate] of [
  ["missing", d => { d.fields.pop(); }], ["duplicate", d => { d.fields[1] = structuredClone(d.fields[0]); }],
  ["extra value", d => { d.fields[0].value = "synthetic-private"; }], ["nested secrets", d => { d.fields[0].hooks = { command: "synthetic-private" }; }],
  ["raw environment", d => { d.env = { apiKey: "synthetic-private" }; }], ["account", d => { d.email = "synthetic-private@example.invalid"; }],
  ["path", d => { d.configDirectory = "/synthetic-private"; }], ["size", d => { d.fields[0].size = 3; }],
  ["boolean value", d => { d.fields[0].booleanValue = false; }], ["coercion", d => { d.fields[0].forced = false; }],
  ["unknown key", d => { d.fields[0].name = "unapproved"; }], ["unknown type", d => { d.fields[0].type = "credential"; }],
  ["unknown source", d => { d.source = "verified-native"; }], ["wrong application", d => { d.application = "another.application"; }],
  ["fake permission", d => { d.nativeStartAuthorized = true; }], ["cycle", d => { d.extra = d; }],
  ["symbol", d => { d[Symbol("secret")] = "synthetic-private"; }], ["nonenumerable", d => { Object.defineProperty(d, "extra", { value: "synthetic-private" }); }],
  ["prototype", d => { Object.setPrototypeOf(d, { extra: "synthetic-private" }); }], ["surrogate", d => { d.fields[0].name = "\ud800"; }]
]) test("NP rejects " + name, () => { const d = wire(); mutate(d); assert.equal(safe(read(d, 0)).state, "invalid"); });
test("NP getters, toJSON and proxies are never executed", () => {
  let calls = 0; const d = wire(); Object.defineProperty(d, "fields", { enumerable: true, get() { calls++; return []; } }); assert.equal(read(d, 0).state, "invalid");
  const j = wire(); j.toJSON = () => { calls++; return wire(); }; assert.equal(read(j, 0).state, "invalid");
  const p = new Proxy({}, { getPrototypeOf() { calls++; return Object.prototype; }, ownKeys() { calls++; return []; } });
  assert.equal(read(p, 0).state, "invalid"); const n = wire(); n.fields[0] = p; assert.equal(read(n, 0).state, "invalid"); assert.equal(calls, 0);
});
for (const value of [undefined, null, [], 1, Buffer.from([0xff]), " ".repeat(32769), '{"source":"x","source":"y"}', '{"__proto__":{}}', '{"constructor":{}}', "\ufeff{}", '{"id":"\\ud800"}', '{"n":1e999}']) test("NP strict adversarial JSON", () => assert.equal(safe(read(value, 0)).state, "invalid"));
test("NP duplicate escaped key inside an otherwise valid wire record", () => {
  const s = JSON.stringify(wire()).replace('"type":"not-found-by-api"', '"type":"not-found-by-api","\\u0074ype":"string"'); assert.equal(read(s, 0).state, "invalid");
});
test("NP exact 32 KiB wire bound, bytes and multibyte strings", () => {
  const s = JSON.stringify(wire()), padded = s + " ".repeat(32768 - Buffer.byteLength(s));
  assert.equal(read(padded, 0).state, "partial-observation"); assert.equal(read(Buffer.from(padded), 0).state, "partial-observation");
  assert.equal(read(padded + " ", 0).state, "invalid"); assert.equal(read("é".repeat(16385), 0).state, "invalid");
});
test("NP incremental split points return no provisional projection", () => {
  const b = Buffer.from(JSON.stringify(wire())), expected = read(b, 0);
  for (let split = 0; split <= b.length; split++) {
    const s = createManagedPreferencesStreamReader(schema, "synthetic"); assert.equal(s.push(b.subarray(0, split)), true);
    assert.equal(s.push(b.subarray(split)), true); assert.deepEqual(s.finish(0), expected);
  }
});
test("NP incremental UTF8 split, invalid tails and closure cannot restore a valid projection", () => {
  const raw = Buffer.from(JSON.stringify({ ...wire(), extra: "synthetic-private-é" }));
  const i = raw.indexOf(Buffer.from("é")), s = createManagedPreferencesStreamReader(schema, "synthetic");
  s.push(raw.subarray(0, i + 1)); s.push(raw.subarray(i + 1)); assert.equal(s.finish(0).state, "invalid");
  const t = createManagedPreferencesStreamReader(schema, "synthetic"); t.push(Buffer.from(JSON.stringify(wire()))); t.push(Buffer.from([0xff]));
  assert.equal(safe(t.finish(0)).state, "invalid"); assert.equal(t.push("ignored"), false); assert.equal(t.finish(0).state, "invalid");
});
for (const reason of ["preferences-transport-timeout", "preferences-transport-overflow", "preferences-transport-unconfirmed", "preferences-transport-changed-artifact", "preferences-transport-error"]) test("NP transport abort discards pending fields: " + reason, () => {
  const s = createManagedPreferencesStreamReader(schema, "synthetic"); s.push(JSON.stringify(wire())); s.abort(reason);
  const r = safe(s.finish(0)); assert.equal(r.state, "invalid"); assert.deepEqual(r.reasons, [reason]);
});
test("NP stream cap and hostile abort reason are closed", () => {
  const s = createManagedPreferencesStreamReader(schema, "synthetic"); assert.equal(s.push(" ".repeat(32768)), true); assert.equal(s.push(" "), false);
  assert.deepEqual(s.finish(0).reasons, ["preferences-transport-overflow"]);
  let calls = 0; const t = createManagedPreferencesStreamReader(schema, "synthetic"); t.abort({ toString() { calls++; return "secret"; } });
  assert.deepEqual(t.finish(0).reasons, ["preferences-transport-error"]); assert.equal(calls, 0);
});
test("NP empty and one-byte chunks cannot grow an unbounded retained parts list", () => {
  const s = createManagedPreferencesStreamReader(schema, "synthetic"), b = Buffer.from(JSON.stringify(wire()));
  for (let i = 0; i < 10000; i++) assert.equal(s.push(""), true);
  for (const byte of b) assert.equal(s.push(Uint8Array.of(byte)), true);
  assert.deepEqual(s.finish(0), read(b, 0));
});
test("NP an abort cannot be recovered by later valid stdout", () => {
  const s = createManagedPreferencesStreamReader(schema, "synthetic"); s.abort("preferences-transport-timeout");
  assert.equal(s.push(JSON.stringify(wire())), false); assert.deepEqual(s.finish(0).fields, []);
});
test("NP nested field permutations and not-found/forced are explicit non-atomic claims", () => {
  const d = wire(); d.fields = d.fields.map(f => ({ forced: "forced", type: f.type, name: f.name })).reverse();
  const r = safe(read(d, 0)); assert.ok(r.reasons.includes("preferences-nonatomic-observation")); assert.equal(r.state, "partial-observation");
});
test("NP invalid schema/source is rejected without raw input", () => {
  for (const source of [undefined, null, {}, "native", "/synthetic-private"]) assert.throws(() => createManagedPreferencesReader(schema, source), /^Error: Invalid managed-preferences schema or source$/);
  const s = structuredClone(schema); s.$defs.field.properties.name.enum.push("unapproved"); assert.throws(() => createManagedPreferencesReader(s, "synthetic"));
});
test("NP every report satisfies a closed schema with false verification flags", () => {
  const ajv = new Ajv2020({ strict: true }); ajv.addSchema(schema); const valid = ajv.compile({ $ref: `${PREFERENCES_SCHEMA_ID}#/$defs/report` });
  for (const d of [null, wire(), { schemaVersion: "1.0.0", source: "synthetic", status: "failed", code: "preferences-backend-failed" }]) {
    const r = safe(read(d, d?.status === "failed" ? 1 : 0)); assert.equal(valid(r), true); r.preferencesQueriedVerified = true; assert.equal(valid(r), false);
  }
});
test("NP decoder/accumulator have no IO, spawn, network, current clock or randomness", () => {
  const data = Buffer.from(JSON.stringify(wire())), restores = [], calls = [];
  const replace = (object, key) => { const old = object[key]; if (typeof old !== "function") return;
    object[key] = () => { calls.push(key); throw Error("forbidden " + key); }; restores.push(() => { object[key] = old; }); };
  try {
    for (const key of ["readFile", "open", "writeFile", "stat", "readdir"]) replace(fs, key);
    for (const key of ["readFileSync", "writeFileSync", "openSync", "statSync", "readdirSync"]) replace(fsSync, key);
    for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) replace(childProcess, key);
    for (const object of [http, https]) for (const key of ["get", "request"]) replace(object, key);
    for (const key of ["connect", "createConnection"]) replace(net, key);
    for (const key of ["randomUUID", "randomBytes", "randomInt", "randomFillSync"]) replace(crypto, key);
    replace(globalThis, "fetch"); replace(Date, "now"); replace(Math, "random"); syncBuiltinESMExports();
    const s = createManagedPreferencesStreamReader(schema, "synthetic"); s.push(data); assert.equal(safe(s.finish(0)).state, "partial-observation"); assert.deepEqual(calls, []);
  } finally { restores.reverse().forEach(fn => fn()); syncBuiltinESMExports(); }
});

const nativeSource = fileURLToPath(new URL("../src/native/managed-preferences.c", import.meta.url));
const fakeBackend = fileURLToPath(new URL("../testing/managed-preferences/backend.c", import.meta.url));
const nativeTest = (name, fn) => test(name, { skip: !supported ? "This compiler/transport fixture requires POSIX; Windows has no Core Foundation backend." : false, timeout: 120000 }, fn);
const syntheticTest = (name, fn) => test(name, { skip: supported ? false : "Requires the POSIX C compiler/transport fixture; it does not emulate Windows or grant native-client admission.", timeout: 120000 }, fn);
async function temp(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-preferences-test-"))); await fs.chmod(root, 0o700); const owned = await fs.lstat(root);
  t.after(async () => { const s = await fs.lstat(root).catch(() => null); if (s?.isDirectory() && !s.isSymbolicLink() && s.dev === owned.dev && s.ino === owned.ino) await fs.rm(root, { recursive: true }); });
  return root;
}
// Full-suite CI runs many compiler/process fixtures concurrently. Allow bounded
// scheduling headroom; retain exit status, output and protocol assertions.
async function execute(file, args, cwd, maxBuffer = 32768) {
  return new Promise(resolve => {
    const child = childProcess.execFile(file, args, { cwd, env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, TMPDIR: cwd }, timeout: 30000, maxBuffer, encoding: "buffer" },
      (error, stdout, stderr) => resolve({ code: error ? (Number.isInteger(error.code) ? error.code : null) : 0, stdout, stderr,
        termination: error ? `code=${error.code}; signal=${error.signal}; killed=${error.killed}` : "completed" }));
    child.stdin.end();
  });
}
async function compile(root, scenario) {
  const artifact = path.join(root, scenario === null ? "production-not-executed" : `synthetic-${scenario}`);
  const args = ["-std=c11", "-Wall", "-Wextra", "-Werror", ...sdkArguments, nativeSource];
  if (scenario === null) args.push("-framework", "CoreFoundation");
  else args.push("-DN1_SYNTHETIC_BACKEND", `-DN1_SCENARIO=${scenario}`, fakeBackend);
  args.push("-o", artifact);
  const r = await execute(compiler, args, root); assert.equal(r.code, 0, r.stderr.toString("utf8")); return artifact;
}
nativeTest("NP production backend links Core Foundation on macOS and rejects non-Apple targets", async t => {
  const root = await temp(t);
  if (process.platform !== 'darwin') {
    const artifact = path.join(root, 'unsupported-native-backend');
    const r = await execute(compiler, ['-std=c11', nativeSource, '-o', artifact], root);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr.toString('utf8'), /Core Foundation backend requires macOS/);
    await assert.rejects(fs.lstat(artifact), {code:'ENOENT'});
    return;
  }
  const artifact = await compile(root, null);
  const symbols = await execute("/usr/bin/nm", ["-u", artifact], root); assert.equal(symbols.code, 0, symbols.termination);
  const s = symbols.stdout.toString("utf8"); assert.match(s, /CFPreferencesCopyAppValue/); assert.match(s, /CFPreferencesAppValueIsForced/); assert.match(s, /CFRelease/);
  assert.doesNotMatch(s, /CFPreferences(?:Set|Synchronize|CopyMultiple|CopyKeyList)/);
  // Deliberately no execute(artifact): compilation is not permission to query preferences.
});
syntheticTest("NP production backend rejects a non-Apple target instead of substituting synthetic preferences", async t => {
  const root = await temp(t), artifact = path.join(root, "unsupported-production");
  const r = await execute(compiler, ["-std=c11", ...sdkArguments, "-U__APPLE__", nativeSource, "-o", artifact], root);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr.toString("utf8"), /Core Foundation backend requires macOS/);
  await assert.rejects(fs.lstat(artifact), { code: "ENOENT" });
});
for (const scenario of [0, 1, 4, 5, 6, 8]) syntheticTest(`NP compiled synthetic backend ${scenario}, six keys with ownership/order enforced`, async t => {
  const root = await temp(t), artifact = await compile(root, scenario), symbols = await execute("/usr/bin/nm", ["-u", artifact], root);
  assert.equal(symbols.code, 0, symbols.termination); assert.doesNotMatch(symbols.stdout.toString("utf8"), /CFPreferences|CFGetTypeID|CFRelease/);
  const r = await execute(artifact, [], root); assert.equal(r.code, 0, r.termination); assert.equal(r.stderr.length, 0); assert.doesNotMatch(r.stdout.toString("utf8"), /synthetic-private/);
  const projection = safe(read(r.stdout, r.code)); assert.equal(projection.state, "partial-observation"); assert.equal(projection.sourceClaim, "synthetic");
  if (scenario === 0) assert.deepEqual(projection.fields.map(f => f.type), ["dictionary", "string", "string", "dictionary", "array", "boolean"]);
  if (scenario === 1) assert.ok(projection.fields.every(f => f.type === "not-found-by-api"));
  if (scenario === 4) assert.ok(projection.fields.every(f => f.forced === "not-forced"));
  if (scenario === 5) assert.ok(projection.fields.every(f => f.type === "other"));
  if (scenario === 6) assert.ok(projection.fields.every(f => f.type === "number"));
  if (scenario === 8) assert.equal(projection.fields[1].type, "not-found-by-api");
});
for (const scenario of [2, 3, 7, 9, 10, 11, 12]) syntheticTest(`NP compiled synthetic failure ${scenario} emits no partial fields or values`, async t => {
  const root = await temp(t), artifact = await compile(root, scenario), r = await execute(artifact, [], root);
  assert.equal(r.code, 1); assert.equal(r.stderr.length, 0); assert.doesNotMatch(r.stdout.toString("utf8"), /fields|synthetic-private/);
  const projection = safe(read(r.stdout, r.code)); assert.equal(projection.state, "helper-failed");
});
syntheticTest("NP helper rejects arguments before any synthetic getter or raw argument output", async t => {
  const root = await temp(t), artifact = await compile(root, 0), r = await execute(artifact, ["synthetic-private-command"], root);
  assert.equal(r.code, 1); const p = safe(read(r.stdout, r.code)); assert.deepEqual(p.reasons, ["preferences-arguments-rejected"]);
  assert.doesNotMatch(r.stdout.toString("utf8"), /synthetic-private/);
});
