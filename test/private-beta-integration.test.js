import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOTE = "03-IMPLEMENTACION/Implementación.md";
const LEDGER = "00-INICIO/Registro de sincronización.md";
const SOURCE_FILE = "frontend/Counter.tsx";
const DATE = "2026-10-09T12:00:00Z"; // Fixed fictitious evidence, not a real PR.
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function snapshot(root) {
  const result = {};
  const walk = dir => {
    const directory = fs.lstatSync(dir);
    assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
    result[path.relative(root, dir).split(path.sep).join("/") + "/"] = {
      type: "directory", hash: null, mode: directory.mode, uid: directory.uid,
      ino: directory.ino, mtimeMs: directory.mtimeMs
    };
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), stat = fs.lstatSync(full);
      assert.equal(stat.isSymbolicLink(), false, "unexpected fixture link");
      if (entry.isDirectory()) walk(full);
      else result[path.relative(root, full).split(path.sep).join("/")] = {
        type: "file", hash: hash(fs.readFileSync(full)), mode: stat.mode, uid: stat.uid,
        ino: stat.ino, mtimeMs: stat.mtimeMs
      };
    }
  };
  walk(root); return result;
}

// Cooperative instrumentation, NOT an OS sandbox or a proof of remote behavior.
function installGuards(root, counts) {
  const originals = [], originalExec = cp.execFileSync;
  const patch = (object, name, replacement) => {
    originals.push([object, name, object[name]]); object[name] = replacement;
  };
  const inside = directory => {
    if (typeof directory !== "string" || !path.isAbsolute(directory) || path.normalize(directory) !== directory ||
        !(directory === root || directory.startsWith(root + path.sep))) return false;
    try { return fs.realpathSync(directory) === directory; } catch { return false; }
  };
  patch(cp, "execFileSync", (command, args, options = {}) => {
    const at = args?.indexOf("-C"), directory = at >= 0 ? args[at + 1] : options.cwd;
    if (command !== "git" || !inside(directory) ||
        ["fetch", "push", "clone", "pull", "ls-remote"].some(word => args.includes(word))) {
      counts.deniedProcess++; throw Error("unexpected process in R1.2");
    }
    const env = { ...(process.platform === "win32" ? {SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root} : {}), PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.homedir(), TMPDIR: root,
      LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
    counts.git++; return originalExec(command, args, { ...options, env });
  });
  for (const name of ["exec", "execSync", "execFile", "spawn", "spawnSync", "fork"])
    patch(cp, name, () => { counts.deniedProcess++; throw Error("unexpected process in R1.2"); });
  const denyNetwork = () => { counts.deniedNetwork++; throw Error("unexpected network in R1.2"); };
  for (const [object, names] of [
    [http, ["request", "get"]], [https, ["request", "get"]],
    [net, ["connect", "createConnection"]], [tls, ["connect"]], [dgram, ["createSocket"]]
  ]) for (const name of names) patch(object, name, denyNetwork);
  patch(globalThis, "fetch", denyNetwork);
  syncBuiltinESMExports();
  return () => {
    for (const [object, name, original] of originals.reverse()) object[name] = original;
    syncBuiltinESMExports();
    for (const [object, name, original] of originals) assert.equal(object[name], original);
  };
}

function removeOwnedFixture(root, expected) {
  const current = fs.lstatSync(root);
  assert.ok(current.isDirectory() && !current.isSymbolicLink());
  assert.equal(fs.realpathSync(root), root);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("agent-toolkit-r12-test-"));
  for (const key of ["dev", "ino", "uid", "mode"]) assert.equal(current[key], expected[key]);
  if (process.platform !== 'win32') {
    assert.equal(current.uid, process.getuid());
    assert.equal(current.mode & 0o7777, 0o700);
  }
  fs.rmSync(root, { recursive: true });
  assert.equal(fs.existsSync(root), false);
}

test("R1.2 integrates a canonical fictitious memory and seven fail-closed cases", {
  timeout: 60000
}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-toolkit-r12-test-")));
  fs.chmodSync(root, 0o700);
  const owner = fs.lstatSync(root), counts = { git: 0, simulatedGitHub: 0, simulatedMcp: 0, deniedProcess: 0, deniedNetwork: 0 };
  const restore = installGuards(root, counts);
  try {
    const module = name => import(pathToFileURL(path.join(TOOLKIT, "src", name + ".js")));
    const { initializeMemory } = await module("init");
    const { diagnoseMemory } = await module("doctor");
    const { inspectMemoryStatus } = await module("status");
    const { planMemorySync, readReviewedPullRequests } = await module("sync");
    const { inspectMemorySync } = await module("sync-inspect");
    const { applyMemorySync } = await module("sync-apply");
    const { recordMemorySync } = await module("sync-record");
    const { runCli } = await module("cli");
    const source = path.join(root, "source"), vault = path.join(root, "memory"), fakeHome = path.join(root, "fixture-home");
    const hooks = path.join(root, "empty-hooks");
    const git = (directory, ...args) => cp.execFileSync("git", [
      "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-C", directory, ...args
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }).trim();
    const configureGit = directory => {
      git(directory, "init", "-b", "main");
      for (const [key, value] of [
        ["user.name", "R12 Fixture"], ["user.email", "r12@example.invalid"], ["core.hooksPath", hooks]
      ]) git(directory, "config", key, value);
    };
    const passedSteps = [], blockedCases = [];
    for (const directory of [source, fakeHome, hooks, path.join(source, "frontend")])
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(source, "README.md"), "# Proyecto ficticio R1.2\n", { mode: 0o600 });
    fs.writeFileSync(path.join(source, SOURCE_FILE), "export const fictitiousMarker = 1;\n", { mode: 0o600 });
    fs.writeFileSync(path.join(fakeHome, "sentinel.txt"), "Configuración ficticia conservada.\n", { mode: 0o600 });
    configureGit(source);
    git(source, "add", "--", "README.md", SOURCE_FILE); git(source, "commit", "-m", "fixture: fuente");
    git(source, "branch", "develop");
    const sourceBaseline = snapshot(source), homeBaseline = snapshot(fakeHome);
    const options = { destination: vault, projectId: "r12-demo", projectName: "Proyecto ficticio R1.2", sourcePath: source,
      defaultBranch: "main", integrationBranch: "develop", syncMode: "git-manual",
      sourceRemote: "https://github.com/demo-owner/demo-source.git", memoryRemote: "https://github.com/demo-owner/demo-memory.git" };
    const beforePreview = snapshot(root), initial = initializeMemory(options, { now: new Date(DATE) });
    assert.equal(initial.status, "preview"); assert.equal(fs.existsSync(vault), false);
    assert.deepEqual(snapshot(root), beforePreview); passedSteps.push("init-preview");
    const created = initializeMemory({ ...options, apply: true }, { now: new Date(DATE) });
    assert.equal(created.status, "created");
    const firstMemory = snapshot(vault);
    assert.equal(initializeMemory({ ...options, apply: true }, { now: new Date(DATE) }).status, "unchanged");
    assert.deepEqual(snapshot(vault), firstMemory); passedSteps.push("init-apply-repeat");

    // This flag enables only the fixture APIs below. No scheduler or real automation is started.
    const manifestPath = path.join(vault, "project-memory.json"), manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.automation.enabled = true; manifest.automation.schedule = "Fictitious test only; no scheduler";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    configureGit(vault);
    // Canonical integration fixture is LF regardless of the developer checkout.
    // Dedicated sync suites cover CRLF worktrees and byte-exact Git pins.
    for (const [name, item] of Object.entries(snapshot(vault))) if (item.type === 'file' && name.endsWith('.md')) {
      const file = path.join(vault, name); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
    }
    git(vault, "add", "--", ...Object.entries(snapshot(vault))
      .filter(([p, item]) => item.type === "file" && !p.startsWith(".git/")).map(([p]) => p));
    git(vault, "commit", "-m", "fixture: memoria");
    git(vault, "remote", "add", "origin", "https://github.com/demo-owner/demo-memory.git");
    git(vault, "update-ref", "refs/remotes/origin/main", git(vault, "rev-parse", "HEAD"));
    git(vault, "config", "branch.main.remote", "origin"); git(vault, "config", "branch.main.merge", "refs/heads/main");
    const head = git(source, "rev-parse", "HEAD"), control = { state: "MERGED", conclusion: "success" };
    const row = { number: 42, title: "Cambio ficticio de interfaz", url: "https://github.com/demo-owner/demo-source/pull/42",
      mergedAt: DATE, mergeCommit: { oid: head } };
    const context = { clock: () => Date.parse(DATE), diagnoseMemory, runCommand(command, args) {
      assert.equal(command, "gh"); counts.simulatedGitHub++;
      if (args[0] === "pr" && args[1] === "list") {
        assert.equal(args[args.indexOf("--state") + 1], "merged");
        assert.equal(args[args.indexOf("--base") + 1], "develop");
        return JSON.stringify(control.state === "MERGED" ? [row] : []);
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ ...row, body: "Evidencia ficticia de R1.2",
        state: control.state, baseRefName: "develop", headRefOid: head, changedFiles: 1 });
      const endpoint = args.find(arg => arg.startsWith("repos/"));
      assert.ok(endpoint, "unexpected simulated GitHub query");
      if (endpoint.includes("/files?")) return JSON.stringify([{ filename: SOURCE_FILE, status: "modified", additions: 1, deletions: 1 }]);
      if (endpoint.includes("/check-runs?")) return JSON.stringify({ total_count: 1, check_runs: [{
        id: 1, app: { id: 1 }, name: "Prueba ficticia", status: "completed", conclusion: control.conclusion, head_sha: head,
        started_at: DATE, completed_at: DATE, html_url: "https://github.com/demo-owner/demo-source/actions/runs/1"
      }] });
      if (endpoint.includes("/status?")) return JSON.stringify({ sha: head, state: "pending", total_count: 0, statuses: [] });
      throw Error("unexpected simulated GitHub query");
    } };
    const beforeRead = snapshot(root), doctor = await diagnoseMemory(vault);
    assert.equal(doctor.status, "ok");
    const status = await inspectMemoryStatus({ targetPath: vault }, { homeDirectory: fakeHome, runCommand(command, args) {
      assert.ok(["codex", "claude"].includes(command));
      assert.deepEqual(args, ["mcp", "get", manifest.memory.mcpServerName]);
      counts.simulatedMcp++; return { status: 1, stdout: "", stderr: "" };
    } });
    assert.equal(status.status, "warning"); assert.equal(status.agents.length, 2);
    assert.equal(status.summary.pendingAgents, 2);
    assert.deepEqual(snapshot(root), beforeRead); passedSteps.push("doctor-status");

    const beforeInspect = snapshot(root), plan = await planMemorySync({ targetPath: vault }, context);
    assert.equal(plan.status, "pending"); assert.deepEqual(plan.pending.map(pr => pr.number), [42]);
    const inspected = await inspectMemorySync({ targetPath: vault, pr: plan.pending[0].number }, context);
    assert.equal(inspected.status, "ready"); assert.equal(inspected.checks.summary.success, 1);
    assert.equal(inspected.candidateAreas[0].directory, "03-IMPLEMENTACION");
    assert.ok(inspected.candidateAreas[0].notes.includes(NOTE));
    assert.equal(inspected.coverage.files.complete, true); assert.equal(inspected.coverage.checks.complete, true);
    assert.deepEqual(snapshot(root), beforeInspect); passedSteps.push("plan-inspect");
    const originalNote = fs.readFileSync(path.join(vault, NOTE), "utf8"), proposalPath = path.join(root, "proposal.json");
    const proposal = { schemaVersion: "1.0.0", projectId: manifest.project.id, repository: inspected.repository,
      reviewBranch: inspected.branch, pr: inspected.pullRequest.number, mergeCommit: inspected.pullRequest.mergeCommit,
      memoryHead: git(vault, "rev-parse", "HEAD"), manifestSha256: hash(fs.readFileSync(manifestPath)),
      notes: [{ path: NOTE, beforeSha256: hash(Buffer.from(originalNote)),
        content: originalNote + "\n## Contexto ficticio aprobado\n\nConvención de interfaz revisada para el PR de prueba.\n".replaceAll("\n", originalNote.includes("\r\n") ? "\r\n" : "\n"),
        sourcePaths: inspected.files.map(file => file.path) }] };
    const saveProposal = () => fs.writeFileSync(proposalPath, JSON.stringify(proposal, null, 2) + "\n", { mode: 0o600 });
    saveProposal(); const input = { targetPath: vault, proposalPath };
    const beforeApply = snapshot(root), preview = await applyMemorySync(input, context);
    assert.equal(preview.status, "preview"); assert.equal(preview.wrote, false);
    assert.match(preview.planId, /^[a-f0-9]{64}$/); assert.deepEqual(snapshot(root), beforeApply); passedSteps.push("apply-preview");
    const blocked = async (name, action, code) => {
      const before = snapshot(root);
      await assert.rejects(action, error => error.code === code);
      assert.deepEqual(snapshot(root), before); blockedCases.push(name);
    };
    control.state = "OPEN";
    const beforeOpen = snapshot(root), open = await planMemorySync({ targetPath: vault }, context);
    assert.equal(open.status, "clean"); assert.deepEqual(open.pending, []); assert.deepEqual(snapshot(root), beforeOpen);
    await blocked("open-pr", () => applyMemorySync(input, context), "inspection-error"); control.state = "MERGED";
    control.conclusion = "failure";
    assert.equal((await inspectMemorySync({ targetPath: vault, pr: 42 }, context)).status, "blocked");
    await blocked("adverse-checks", () => applyMemorySync(input, context), "incomplete-evidence"); control.conclusion = "success";
    await blocked("wrong-approved-pin", () => applyMemorySync({ ...input, apply: true, reviewed: true, expect: "0".repeat(64) }, context), "approval-mismatch");
    const reviewedHead = proposal.memoryHead; proposal.memoryHead = "0".repeat(40); saveProposal();
    await blocked("wrong-memory-base", () => applyMemorySync(input, context), "memory-version"); proposal.memoryHead = reviewedHead; saveProposal();
    fs.writeFileSync(path.join(vault, NOTE), originalNote + "\nContenido concurrente ficticio.\n".replaceAll("\n", originalNote.includes("\r\n") ? "\r\n" : "\n"));
    await blocked("different-note-content", () => applyMemorySync(input, context), "note-conflict");
    fs.writeFileSync(path.join(vault, NOTE), originalNote);
    const foreign = path.join(vault, "foreign.txt");
    fs.writeFileSync(foreign, "Trabajo ajeno simulado, no editable por la biblioteca.\n", { flag: "wx", mode: 0o600 });
    await blocked("unrelated-local-change", () => applyMemorySync(input, context), "foreign-changes");
    fs.unlinkSync(foreign); // Remove only the synthetic file this fixture just created.

    // Obtain a fresh preview after explicitly restoring our own adversarial fixture inputs.
    const reviewed = await applyMemorySync(input, context), beforeWrite = snapshot(vault);
    const indexBefore = hash(fs.readFileSync(path.join(vault, ".git/index")));
    const applied = await applyMemorySync({ ...input, apply: true, reviewed: true, expect: reviewed.planId }, context);
    assert.equal(applied.status, "applied"); assert.equal(applied.wrote, true); assert.deepEqual(applied.applied, [NOTE]);
    assert.equal(fs.readFileSync(path.join(vault, NOTE), "utf8"), proposal.notes[0].content);
    const afterWrite = snapshot(vault);
    assert.deepEqual(Object.keys(afterWrite).filter(p => afterWrite[p].hash !== beforeWrite[p]?.hash), [NOTE]);
    assert.equal(hash(fs.readFileSync(path.join(vault, ".git/index"))), indexBefore); passedSteps.push("apply-reviewed");
    const beforeRepeat = snapshot(root), repeatPreview = await applyMemorySync(input, context);
    assert.equal(repeatPreview.status, "unchanged"); assert.equal(repeatPreview.planId, reviewed.planId);
    const repeatApply = await applyMemorySync({ ...input, apply: true, reviewed: true, expect: repeatPreview.planId }, context);
    assert.equal(repeatApply.status, "unchanged"); assert.equal(repeatApply.wrote, false);
    assert.deepEqual(snapshot(root), beforeRepeat); passedSteps.push("apply-repeat");

    const recordInput = { targetPath: vault, pr: applied.pr, outcome: "documentation-updated", reviewed: true,
      summary: "Contexto ficticio de interfaz revisado", notes: applied.applied };
    const beforeRecord = snapshot(root), recordPreview = await recordMemorySync(recordInput, context);
    assert.equal(recordPreview.status, "preview"); assert.equal(recordPreview.wrote, false); assert.deepEqual(snapshot(root), beforeRecord);
    const beforeLedger = snapshot(vault), recorded = await recordMemorySync({ ...recordInput, apply: true }, context);
    assert.equal(recorded.status, "recorded"); assert.equal(recorded.wrote, true);
    const afterLedger = snapshot(vault);
    assert.deepEqual(Object.keys(afterLedger).filter(p => afterLedger[p].hash !== beforeLedger[p]?.hash), [LEDGER]);
    assert.equal(hash(fs.readFileSync(path.join(vault, ".git/index"))), indexBefore); passedSteps.push("record-preview-apply");
    const beforeNoOp = snapshot(root), noOp = await recordMemorySync({ ...recordInput, apply: true }, context);
    assert.equal(noOp.status, "unchanged"); assert.equal(noOp.wrote, false);
    const finalPlan = await planMemorySync({ targetPath: vault }, context);
    assert.equal(finalPlan.status, "clean"); assert.deepEqual(finalPlan.reviewed, [42]); assert.deepEqual(finalPlan.pending, []);
    assert.equal(readReviewedPullRequests(path.join(vault, LEDGER), "demo-owner/demo-source").size, 1);
    assert.deepEqual(snapshot(root), beforeNoOp); passedSteps.push("record-repeat-plan");
    await blocked("already-reviewed", () => applyMemorySync(input, context), "already-reviewed");

    const dirty = await diagnoseMemory(vault); assert.equal(dirty.status, "warning");
    assert.deepEqual(dirty.checks.filter(c => c.level === "warning").map(c => c.id), ["git-cleanliness"]);
    git(vault, "add", "--", NOTE, LEDGER); git(vault, "commit", "-m", "fixture: revisión");
    assert.equal((await diagnoseMemory(vault)).status, "ok");
    const output = [], errors = [], beforeCli = snapshot(root);
    assert.equal(await runCli(["sync", "plan", vault, "--json"], { out: s => output.push(s), err: s => errors.push(s) }, context), 0);
    assert.equal(JSON.parse(output.join("\n")).status, "clean"); assert.deepEqual(errors, []);
    assert.deepEqual(snapshot(root), beforeCli); assert.deepEqual(snapshot(source), sourceBaseline);
    assert.deepEqual(snapshot(fakeHome), homeBaseline); passedSteps.push("final-diagnosis-preservation");
    assert.equal(passedSteps.length, 10); assert.equal(blockedCases.length, 7);
    assert.equal(counts.deniedProcess, 0); assert.equal(counts.deniedNetwork, 0);
    assert.equal(counts.simulatedMcp, 2); assert.ok(counts.simulatedGitHub > 0);
    t.diagnostic(JSON.stringify({ scope: "fictitious-memory-only", passedSteps, blockedCases,
      sourceUnchanged: true, fakeHomeUnchanged: true, network: "simulated-only",
      realClientsStarted: false, nativeAdmission: false, remotePublication: false }));
  } finally {
    // Restore every patched API even when an assertion fails; cleanup never targets the Toolkit.
    try { restore(); } finally { removeOwnedFixture(root, owner); }
  }
});
