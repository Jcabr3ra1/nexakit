import { supported } from "../testing/client-posix.js";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createSupervisedProtocol } from "../src/client-supervised-protocol.js";
import { createSupervisedSupervisor } from "../src/client-supervised-supervisor.js";
import { createSupervisedContract, FIXTURE_IDS, hash, monotonicMs } from "../src/client-supervised-contract.js";
import { createFixturePermit } from "../src/client-runtime-fixture-permit.js";
import { claimSupervisedPermit } from "../src/client-supervised-permit.js";
import { schema, store, request, setup, coordinator, limits, taskDirectory } from "../testing/supervised/setup.js";

const contract = createSupervisedContract(schema);
const localTest = (name, fn) => test(name, { skip: supported ? false : "requires POSIX ownership, private workspaces and process-group termination", timeout: 20000 }, fn);
const check = r => {
  assert.equal(r.scope, "fixture-only"); assert.equal(r.nativeExecuted, false); assert.equal(r.runtimeReady, false);
  assert.equal(r.verifiedAdmission, false); assert.equal(r.actualModelCalls, null); assert.equal(r.internalCallCeiling, null);
  assert.equal(r.remoteCancellationVerified, false);
  assert.doesNotMatch(JSON.stringify(r), /synthetic-private|supervised-private|do-not-run|\/Users\/|agent-supervised-test|NODE_OPTIONS/);
  if (r.process) contract.processReport(r.process); return r;
};

test("S2 protocol: closed fixture registry matches schema", () => assert.deepEqual([...FIXTURE_IDS], schema.$defs.fixtureId.enum));
test("S2 protocol: UTF-8 and CRLF across all split points", () => {
  const b = Buffer.from('{"s":2,"type":"start"}\r\n{"s":2,"type":"data","text":"á🐣"}\r\n{"s":2,"type":"end","ok":true}\r\n');
  for (let i = 1; i < b.length; i++) { const p = createSupervisedProtocol(limits()); p.push(b.subarray(0, i)); p.push(b.subarray(i)); p.finish(); assert.equal(p.counts().events, 3); }
});
for (const [name, data, cause] of [
  ["C2 protocol", '{"v":1,"type":"start"}\n', "supervised-invalid-event"],
  ["tool", '{"s":2,"type":"tool"}\n', "supervised-forbidden-event"],
  ["delegation", '{"s":2,"type":"subagent"}\n', "supervised-forbidden-event"],
  ["fallback", '{"s":2,"type":"fallback"}\n', "supervised-forbidden-event"],
  ["permission", '{"s":2,"type":"permission"}\n', "supervised-forbidden-event"],
  ["extra field", '{"s":2,"type":"start","argv":[]}\n', "supervised-forbidden-event"],
  ["end first", '{"s":2,"type":"end","ok":true}\n', "supervised-forbidden-event"],
  ["duplicate start", '{"s":2,"type":"start"}\n{"s":2,"type":"start"}\n', "supervised-forbidden-event"],
  ["duplicate key", '{"s":2,"s":2,"type":"start"}\n', "duplicate-json-key"],
  ["duplicate final", '{"s":2,"type":"start"}\n{"s":2,"type":"end","ok":true}\n{"s":2,"type":"end","ok":true}\n', "supervised-after-terminal"],
  ["invalid UTF8", Buffer.from([0xff, 10]), "invalid-utf8"],
  ["invalid Unicode", '{"s":2,"type":"data","text":"\\ud800"}\n', "invalid-unicode"],
  ["fractional version", '{"s":2.5,"type":"start"}\n', "supervised-invalid-event"]
]) test("S2 protocol rejects " + name, () => {
  assert.throws(() => createSupervisedProtocol(limits()).push(Buffer.from(data)), e => e.code === cause);
});
test("S2 protocol: output/line/events exact bounds and one byte over", () => {
  const b = Buffer.from('{"s":2,"type":"start"}\n{"s":2,"type":"end","ok":true}\n');
  const n = b.indexOf(10), m = b.length - n - 2;
  const exact = createSupervisedProtocol({ ...limits(), maxOutputBytes: b.length, maxLineBytes: Math.max(n, m), maxEvents: 2 }); exact.push(b); exact.finish();
  assert.throws(() => createSupervisedProtocol({ ...limits(), maxOutputBytes: b.length - 1 }).push(b), /supervised-output-limit/);
  assert.throws(() => createSupervisedProtocol({ ...limits(), maxLineBytes: Math.max(n, m) - 1 }).push(b), /supervised-line-limit/);
  assert.throws(() => createSupervisedProtocol({ ...limits(), maxEvents: 1 }).push(b), /supervised-event-limit/);
  const p = createSupervisedProtocol({ ...limits(), maxLineBytes: 10 }); assert.throws(() => p.push(Buffer.alloc(11)), /supervised-line-limit/); assert.equal(p.counts().retainedLineBytes, 0);
});
test("S2 protocol: incomplete or unterminated stream cannot complete", () => {
  const p = createSupervisedProtocol(limits()); p.push(Buffer.from('{"s":2,"type":"start"}')); assert.throws(() => p.finish(), /unterminated/);
  const q = createSupervisedProtocol(limits()); q.push(Buffer.from('{"s":2,"type":"start"}\n')); assert.throws(() => q.finish(), /incomplete/);
});

for (const mode of ["success", "split-utf8", "environment"]) localTest("S2 runtime: " + mode, async t => {
  const root = await setup(t), d = request(mode), before = structuredClone(d); let spawns = 0;
  const r = check(await coordinator(root, { supervisor: { spawn: (...args) => {
    spawns++; assert.equal(args[0], process.execPath); assert.equal(args[1].length, 2);
    assert.equal(args[2].shell, false); assert.equal(args[2].detached, true);
    assert.deepEqual(args[2].env, { LANG: "C", LC_ALL: "C" });
    return spawn(...args);
  }, checkpoint: async name => { if (name === "before-spawn") {
    const state = await store(root).observe(d.identity); assert.equal(state.lastState, "start-claimed"); assert.equal(state.state, "reconciliation-required");
  } } } })(d));
  assert.equal(r.state, "completed-for-review", JSON.stringify(r)); assert.equal(r.fixtureExecuted, true); assert.equal(spawns, 1);
  assert.equal(r.process.metrics.terminationConfirmed, true); assert.equal(r.process.groupObservation, "absent"); assert.equal(r.storage.state, "recorded");
  const s = await store(root).observe(d.identity); assert.equal(s.state, "consumed"); assert.equal(s.mainStartsObserved, 1); assert.equal(s.actualModelCalls, null);
  assert.deepEqual(d, before); assert.equal((await coordinator(root)(d)).fixtureExecuted, false);
  assert.equal((await fs.readdir(root)).filter(p => p.startsWith("agent-supervised-work-")).length, 0);
});
for (const [mode, code, state] of [
  ["failure", "supervised-exit-failed", "failed"], ["stdout-overflow", "supervised-line-limit", "failed"],
  ["stderr-overflow", "supervised-stderr-limit", "failed"], ["stderr-invalid", "supervised-stderr-invalid-utf8", "failed"],
  ["long-line", "supervised-line-limit", "failed"], ["event-overflow", "supervised-event-limit", "failed"],
  ["invalid-utf8", "invalid-utf8", "failed"], ["forbidden-event", "supervised-forbidden-event", "failed"],
  ["duplicate-json", "duplicate-json-key", "failed"], ["after-terminal", "supervised-after-terminal", "failed"],
  ["unterminated", "supervised-unterminated-line", "failed"], ["incomplete", "supervised-incomplete-protocol", "failed"],
  ["silent", "supervised-deadline", "timed-out"], ["blocked-stdin", "supervised-deadline", "timed-out"],
  ["closed-stdin", "supervised-deadline", "timed-out"], ["ignore-term", "supervised-deadline", "timed-out"],
  ["parent-child", "supervised-deadline", "timed-out"], ["child-after-parent", "supervised-descendants-live", "failed"]
]) localTest("S2 runtime handles " + mode, async t => {
  const root = await setup(t), d = request(mode);
  if (["silent", "blocked-stdin", "closed-stdin", "ignore-term", "parent-child"].includes(mode)) {
    d.limits.timeoutMs = 1500; d.limits.graceMs = 150; d.limits.confirmationMs = 350;
  }
  // The child of the group can take longer to vanish on a loaded runner; without the margin the supervisor
  // rightly answers "indeterminate" instead of "timed-out".
  if (mode === "parent-child") { d.limits.timeoutMs = 3000; d.limits.confirmationMs = 1000; }
  const r = check(await coordinator(root)(d)); assert.equal(r.state, state, JSON.stringify(r));
  assert.ok(r.reasons.includes(code), JSON.stringify(r)); assert.equal(r.process.metrics.terminationConfirmed, true);
  assert.ok(r.process.metrics.elapsedMs <= d.limits.timeoutMs); assert.equal(r.storage.state, "recorded");
  assert.equal((await store(root).observe(d.identity)).state, "consumed"); assert.equal((await coordinator(root)(d)).fixtureExecuted, false);
});
for (const h of [null, {}, createFixturePermit(async () => {}, async () => {})]) localTest("S2 runner rejects fake/C2 permission", async t => {
  const root = await setup(t); let spawns = 0;
  const r = await createSupervisedSupervisor(schema, { workspaceParent: root, spawn: () => { spawns++; throw Error("do not spawn"); } })(h, request());
  assert.equal(spawns, 0); assert.equal(r.fixtureExecuted, false); assert.deepEqual(r.reasons, ["supervised-local-error"]); check(r);
});
for (const [name, handle] of [
  ["null", () => null], ["plain object", () => ({})],
  ["C2 handle", callback => createFixturePermit(callback, callback)]
]) test("S2 permit boundary rejects " + name + " before callbacks/spawn", { timeout: 20000 }, async () => {
  let callbacks = 0, spawns = 0;
  const h = handle(async () => { callbacks++; });
  // Exercise the capability API directly: Windows runner admission would mask it.
  const consume = async () => {
    const capability = await claimSupervisedPermit(h, hash(request()));
    await capability.started();
    spawns++;
  };
  await assert.rejects(consume(), { message: "Supervised permit unavailable" });
  assert.equal(callbacks, 0); assert.equal(spawns, 0);
});
test("S2 coordinator validates request before any storage/spawn", { timeout: 20000 }, async t => {
  const root = await setup(t); let spawns = 0;
  const run = coordinator(root, { supervisor: { spawn: () => { spawns++; throw Error("no"); } } });
  for (const [d, reason] of [
    [{ state: "ready-for-supervised-review" }, "supervised-invalid-request"],
    [{ ...request(), command: "claude" }, "supervised-invalid-request"],
    [{ ...request(), scope: "supervised-subscription" }, "supervised-invalid-request"],
    [new Proxy({}, {}), "non-json-metadata"]
  ]) {
    const r = check(await run(d)); assert.equal(r.state, "not-started"); assert.equal(r.storage, null);
    assert.deepEqual(r.reasons, [reason]);
  }
  assert.equal(spawns, 0); assert.deepEqual(await fs.readdir(root), []);
});
test("S2 runner validates request before platform admission or permission claim", { timeout: 20000 }, async () => {
  let spawns = 0;
  const run = createSupervisedSupervisor(schema, { spawn: () => { spawns++; throw Error("unexpected spawn"); } });
  for (const [d, reason] of [
    [{ state: "ready-for-supervised-review" }, "supervised-invalid-request"],
    [{ ...request(), command: "claude" }, "supervised-invalid-request"],
    [{ ...request(), scope: "supervised-subscription" }, "supervised-invalid-request"],
    [new Proxy({}, {}), "non-json-metadata"]
  ]) {
    const r = check(await run(null, d));
    assert.equal(r.state, "not-started"); assert.equal(r.fixtureExecuted, false);
    assert.deepEqual(r.reasons, [reason]); assert.equal(r.metrics.spawnAttempts, 0);
  }
  assert.equal(spawns, 0);
});
localTest("S2 no native network calls while running a fixture", async t => {
  const root = await setup(t); let calls = 0;
  const old = { hr: http.request, hg: http.get, sr: https.request, sg: https.get, nc: net.connect, ncc: net.createConnection, fetch: globalThis.fetch };
  const deny = () => { calls++; throw Error("network prohibited"); };
  http.request = http.get = https.request = https.get = net.connect = net.createConnection = globalThis.fetch = deny;
  try { assert.equal(check(await coordinator(root)(request())).state, "completed-for-review"); assert.equal(calls, 0); }
  finally { http.request = old.hr; http.get = old.hg; https.request = old.sr; https.get = old.sg; net.connect = old.nc; net.createConnection = old.ncc; globalThis.fetch = old.fetch; }
});
localTest("S2 one spawn under concurrent coordinators and real processes", async t => {
  const root = await setup(t); let starts = 0;
  const deps = { supervisor: { spawn: (...a) => { starts++; return spawn(...a); } } };
  const both = await Promise.all([coordinator(root, deps)(request()), coordinator(root, deps)(request())]);
  assert.equal(both.filter(r => r.fixtureExecuted).length, 1); assert.equal(starts, 1);
  const root2 = await setup(t), worker = fileURLToPath(new URL("../testing/supervised/store-worker.js", import.meta.url));
  const run = async () => {
    const p = spawn(process.execPath, [worker, root2, "coordinate"], { env: { LANG: "C", LC_ALL: "C", TMPDIR: path.dirname(root2) }, stdio: ["ignore", "pipe", "pipe"] });
    let s = "", e = ""; p.stdout.on("data", b => { s += b; }); p.stderr.on("data", b => { e += b; });
    const [code] = await once(p, "close"); assert.equal(code, 0); assert.equal(e, ""); return JSON.parse(s);
  };
  const two = await Promise.all([run(), run()]); assert.equal(two.filter(r => r.fixtureExecuted).length, 1);
});
localTest("S2 canceled before reservation does not consume budget", async t => {
  const root = await setup(t), abort = new AbortController(); abort.abort();
  const r = check(await coordinator(root)(request(), { signal: abort.signal }));
  assert.equal(r.fixtureExecuted, false); assert.deepEqual(await fs.readdir(root), []);
});
localTest("S2 cancel after reservation but before claim consumes the task", async t => {
  const root = await setup(t), abort = new AbortController();
  const r = check(await coordinator(root, { supervisor: { checkpoint: async name => { if (name === "before-claim") abort.abort(); } } })(request(), { signal: abort.signal }));
  assert.equal(r.fixtureExecuted, false); assert.notEqual((await store(root).observe(request().identity)).state, "clear");
  assert.equal((await coordinator(root)(request())).fixtureExecuted, false);
});
localTest("S2 abort during process confirms local group termination", async t => {
  const root = await setup(t), abort = new AbortController();
  const r = check(await coordinator(root, { supervisor: { checkpoint: async name => { if (name === "spawn-observed") setTimeout(() => abort.abort(), 30); } } })(request("silent"), { signal: abort.signal }));
  assert.equal(r.state, "canceled", JSON.stringify(r)); assert.equal(r.process.metrics.terminationConfirmed, true);
});
localTest("S2 elapsed storage/preparation time counts before spawn", async t => {
  const root = await setup(t); let starts = 0;
  const d = request(); d.limits.timeoutMs = 400;
  const r = check(await coordinator(root, { store: { checkpoint: async name => { if (name === "durable-reserved") await new Promise(r => setTimeout(r, 160)); } },
    supervisor: { spawn: () => { starts++; throw Error("no"); } } })(d));
  assert.equal(starts, 0); assert.ok(r.reasons.includes("supervised-deadline-before-start"), JSON.stringify(r));
  assert.equal((await store(root).observe(d.identity)).state, "consumed");
});
localTest("S2 synchronous spawn failure preserves consumed right", async t => {
  const root = await setup(t); let n = 0;
  const r = check(await coordinator(root, { supervisor: { spawn: () => { n++; throw Error("private process exception"); } } })(request()));
  assert.equal(n, 1); assert.equal(r.fixtureExecuted, false); assert.equal(r.storage.state, "recorded");
  assert.equal((await store(root).observe(request().identity)).state, "consumed");
});
localTest("S2 failed post-spawn record is indeterminate, no false completion", async t => {
  const root = await setup(t);
  const r = check(await coordinator(root, { store: { checkpoint: async name => { if (name === "after-write-started") throw Error("disk failed"); } } })(request("silent")));
  assert.equal(r.state, "indeterminate"); assert.equal(r.process.metrics.terminationConfirmed, true);
  assert.equal((await store(root).observe(request().identity)).state, "reconciliation-required");
});
localTest("S2 failed terminal persistence prevents successful coordinator report", async t => {
  const root = await setup(t);
  const r = check(await coordinator(root, { store: { checkpoint: async name => { if (name === "after-write-completed-for-review") throw Error("disk failed"); } } })(request()));
  assert.equal(r.state, "indeterminate"); assert.equal(r.process.state, "completed-for-review");
  assert.equal((await coordinator(root)(request())).fixtureExecuted, false);
});
localTest("S2 uncertain group observation retains workspace and blocks task", async t => {
  const root = await setup(t);
  const r = check(await coordinator(root, { supervisor: { kill: () => { const e = Error("denied"); e.code = "EPERM"; throw e; } } })(request()));
  // Success program itself terminates; denied observations deliberately prevent
  // reporting proof of group termination. No live hanging child is abandoned.
  assert.equal(r.state, "indeterminate"); assert.equal(r.process.metrics.terminationConfirmed, false);
  assert.ok((await fs.readdir(root)).some(p => p.startsWith("agent-supervised-work-")));
  assert.equal((await store(root).observe(request().identity)).state, "reconciliation-required");
});
localTest("S2 late started-write cannot race terminal persistence", async t => {
  const root = await setup(t); let release;
  const hold = new Promise(r => { release = r; }); const d = request(); d.limits.timeoutMs = 400;
  const r = check(await coordinator(root, { store: { checkpoint: async name => { if (name === "after-write-started") await hold; } } })(d));
  assert.equal(r.state, "indeterminate"); release();
  await new Promise(r => setTimeout(r, 50));
  const state = await store(root).observe(d.identity); assert.equal(state.state, "reconciliation-required");
  assert.equal((await fs.readdir(taskDirectory(root))).includes("0003.json"), false);
});
localTest("S2 workspace is empty and private, no project content", async t => {
  const root = await setup(t);
  const r = await coordinator(root, { supervisor: { spawn: (...args) => {
    const s = fs.lstat(args[2].cwd); // Async assertion below is only a trusted test spy.
    t.after(async () => { assert.equal((await s).mode & 0o777, 0o700); });
    return spawn(...args);
  } } })(request()); assert.equal(r.state, "completed-for-review");
});
localTest("S2 late final persistence cannot be presented as within total deadline", async t => {
  // The process must finish inside the deadline and only the final persistence must miss it; 500 ms was too tight
  // for the process itself on a loaded runner, which then reported "timed-out".
  const root = await setup(t), d = request(); d.limits.timeoutMs = 2000;
  const r = check(await coordinator(root, { store: { checkpoint: async name => {
    if (name === "durable-completed-for-review") await new Promise(r => setTimeout(r, 2010));
  } } })(d));
  assert.equal(r.state, "indeterminate"); assert.ok(r.elapsedMs > d.limits.timeoutMs);
  assert.ok(r.reasons.includes("supervised-deadline")); assert.equal((await coordinator(root)(d)).fixtureExecuted, false);
});
localTest("S2 excessive stdout byte count stops before unbounded accumulation", async t => {
  const root = await setup(t), d = request("stdout-overflow"); d.limits.maxOutputBytes = 100;
  d.limits.maxLineBytes = 100;
  const r = check(await coordinator(root)(d)); assert.equal(r.state, "failed");
  assert.ok(r.reasons.includes("supervised-output-limit")); assert.equal(r.process.metrics.terminationConfirmed, true);
});
localTest("S2 async spawn error does not invent a main start", async t => {
  const root = await setup(t);
  const r = check(await coordinator(root, { supervisor: { spawn: (_exec, args, options) => spawn("/supervised-synthetic-missing-executable", args, options) } })(request()));
  assert.equal(r.fixtureExecuted, false); assert.equal(r.process.metrics.mainStartsObserved, 0);
  assert.equal(r.process.metrics.spawnAttempts, 1); assert.equal(r.process.metrics.terminationConfirmed, true);
  assert.ok(r.reasons.includes("supervised-spawn-failed")); assert.equal((await store(root).observe(request().identity)).state, "consumed");
});
localTest("S2 EPIPE after fixture closes stdin is a controlled failure", async t => {
  const root = await setup(t);
  const r = check(await coordinator(root, { supervisor: { spawn: (...args) => {
    const p = spawn(...args); const end = p.stdin.end.bind(p.stdin);
    p.stdin.end = (...a) => { const timer = setTimeout(() => end(...a), 200); p.once("close", () => clearTimeout(timer)); return p.stdin; };
    return p;
  } } })(request("closed-stdin")));
  assert.equal(r.state, "failed", JSON.stringify(r)); assert.ok(r.reasons.includes("supervised-stdin-error"));
  assert.equal(r.process.metrics.terminationConfirmed, true);
});
