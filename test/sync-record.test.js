import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { appendLedgerRecord, parseWritableLedger } from "../src/sync-ledger.js";
import { recordMemorySync, recordErrorReport, LEDGER_PATH, RECORD_LIMITS } from "../src/sync-record.js";
import { readReviewedPullRequests } from "../src/sync.js";
import { fileSymlinkSkipReason } from "../testing/symlink-capability.js";

const DATE = "2026-10-01T14:00:00Z";
const HEAD = "a".repeat(40), MERGE = "b".repeat(40);
const NOTE = "03-IMPLEMENTACION/Implementación.md";
const HEADER = "| Cambio | Estado | Fecha | Resultado | Commit de memoria |";
const LEGACY = "| PR | Estado | Fecha de revisión | Resultado | Commit de memoria |";
const SEPARATOR = "| --- | --- | --- | --- | --- |";
const posixPermissions = { skip: process.platform === "win32" ? "Windows no conserva modos POSIX como 0640." : false };
const fileSymlinks = { skip: fileSymlinkSkipReason() };
const defaultRow = (number = 42, result = "Sin cambios documentales") =>
  `| [#${number}](https://github.com/owner/project/pull/${number}) | Revisado | 2026-10-01 | ${result} | — |`;

function git(dir, ...args) {
  return execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-C", dir, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function fixture(t, options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-record-")));
  const owner = fs.lstatSync(root);
  t.after(() => {
    const current = fs.lstatSync(root, { throwIfNoEntry: false });
    if (current?.isDirectory() && !current.isSymbolicLink() && current.dev === owner.dev && current.ino === owner.ino)
      fs.rmSync(root, { recursive: true });
  });
  const vault = path.join(root, "memory"), source = path.join(root, "source");
  for (const dir of [vault, source, path.join(vault, "00-INICIO"), path.join(vault, "03-IMPLEMENTACION"), path.join(root, "fake-home")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, "fake-home", "settings.json"), "{\"unchanged\":true}\n");
  const ledgerPath = path.join(vault, LEDGER_PATH), notePath = path.join(vault, NOTE);
  const table = options.ledger ?? ["---", "tipo: control", "---", "", "# Registro", "", options.legacy ? LEGACY : HEADER,
    SEPARATOR, ...(options.rows ?? []), "", "## Reglas", "", "Conservar esta sección.\n"].join("\n");
  fs.writeFileSync(ledgerPath, table);
  fs.writeFileSync(notePath, "# Implementación\n\nContexto estable.\n");
  fs.writeFileSync(path.join(source, "source.txt"), "Fuente inalterada.\n");
  const manifestPath = path.join(vault, "project-memory.json");
  const manifest = {
    schemaVersion: "1.0.0", project: { id: "sample-project", name: "Proyecto de prueba" },
    source: { repositoryPath: source, defaultBranch: "main", integrationBranch: "develop", remoteUrl: "https://github.com/owner/project.git" },
    memory: { vaultPath: vault, repositoryBranch: "main", mcpServerName: "sample-memory", syncMode: "git-manual",
      layout: { profile: "declared", requiredDirectories: ["00-INICIO", "03-IMPLEMENTACION"], requiredNotes: [LEDGER_PATH, NOTE] } },
    agents: [{ id: "codex", enabled: true }],
    security: { mcpAccess: "read-only", sensitiveDataPolicy: "forbidden", writeRequiresExplicitAuthorization: true, allowCredentialsInMemory: false },
    automation: { enabled: true, reviewBranch: "develop", requiresMergedChange: true }
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  for (const dir of [source, vault]) {
    git(dir, "init", "-b", "main");
    git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "fixture@example.invalid");
    if (options.autocrlf !== undefined) git(dir, "config", "core.autocrlf", String(options.autocrlf));
  }
  git(source, "add", "--", "source.txt"); git(source, "commit", "-m", "fixture");
  git(vault, "add", "--", LEDGER_PATH, NOTE, "project-memory.json"); git(vault, "commit", "-m", "fixture");
  git(vault, "remote", "add", "origin", "https://github.com/owner/memory.git");
  git(vault, "update-ref", "refs/remotes/origin/main", git(vault, "rev-parse", "HEAD").trim());
  git(vault, "config", "branch.main.remote", "origin"); git(vault, "config", "branch.main.merge", "refs/heads/main");
  const calls = [];
  const context = {
    clock: () => Date.parse(DATE),
    diagnoseMemory: async () => {
      const dirty = Boolean(git(vault, "status", "--porcelain").trim());
      const checks = [...(dirty ? [{ id: "git-cleanliness", level: "warning" }] : []), ...(options.doctorChecks ?? [])];
      return { status: options.doctorStatus ?? (checks.some((item) => item.level === "warning") ? "warning" : "ok"),
        manifestPath, vaultPath: vault, sourcePath: source, checks };
    },
    runCommand(command, args, limits) {
      calls.push({ command, args, limits });
      options.onQuery?.({ args, vault, manifestPath, ledgerPath, notePath });
      if (options.providerError) throw options.providerError;
      if (args[0] === "pr") return JSON.stringify({ number: 42, url: "https://github.com/owner/project/pull/42", title: "Cambio revisado", body: "Contexto",
        state: "MERGED", baseRefName: "develop", headRefOid: HEAD, mergeCommit: { oid: MERGE }, mergedAt: DATE,
        changedFiles: 1, ...options.pr });
      const endpoint = args.find((arg) => arg.startsWith("repos/"));
      if (endpoint.includes("/files?")) return JSON.stringify(options.files ?? [{ filename: "frontend/Page.tsx", status: "modified", additions: 2, deletions: 1 }]);
      if (endpoint.includes("/check-runs?")) {
        const checks = options.checks ?? [{ id: 1, app: { id: 1 }, name: "Tests", status: "completed", conclusion: "success", head_sha: HEAD,
          html_url: options.checkUrl ?? "https://github.com/owner/project/actions/runs/1", completed_at: DATE, started_at: DATE }];
        return JSON.stringify({ total_count: checks.length, check_runs: checks });
      }
      if (endpoint.includes("/status?")) return JSON.stringify({ sha: HEAD, state: "pending", total_count: 0, statuses: [] });
      throw new Error("Unexpected query");
    }
  };
  const input = { targetPath: vault, pr: 42, outcome: "no-documentation-change", reviewed: true };
  return { root, vault, source, ledgerPath, notePath, manifestPath, manifest, context, input, calls,
    record: (extra = {}, override = {}) => recordMemorySync({ ...input, ...extra }, { ...context, ...override }),
    changeNote: (text = "# Implementación\n\nContexto actualizado.\n") => fs.writeFileSync(notePath, text),
    commit: (...files) => { git(vault, "add", "--", ...files); git(vault, "commit", "-m", "fixture update"); } };
}

function snapshot(root) {
  const result = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name), relative = path.relative(root, full);
      if (entry.isDirectory()) walk(full);
      else if (entry.isSymbolicLink()) result[relative] = { link: fs.readlinkSync(full) };
      else result[relative] = { mode: fs.statSync(full).mode & 0o777, hash: createHash("sha256").update(fs.readFileSync(full)).digest("hex") };
    }
  }
  walk(root); return result;
}

function artifacts(f) {
  return fs.readdirSync(path.dirname(f.ledgerPath)).filter((name) => name.startsWith(".project-memory-sync-record"));
}

const updated = (notes = [NOTE]) => ({ outcome: "documentation-updated", summary: "Actualizar el contexto", notes });

test("record prepara vista previa y preserva memoria, fuente, índice y configuración", async (t) => {
  const f = fixture(t); fs.utimesSync(f.manifestPath, new Date("2026-09-01"), new Date("2026-09-01"));
  const before = snapshot(f.root);
  const report = await f.record();
  assert.equal(report.status, "preview"); assert.equal(report.wrote, false);
  assert.equal(report.mergeCommit, MERGE); assert.equal(report.result, "Sin cambios documentales");
  assert.deepEqual(snapshot(f.root), before); assert.deepEqual(artifacts(f), []);
  assert(f.calls.every((call) => call.command === "gh" && call.limits.timeout <= 30_000));
});

test("apply añade solo una fila, preserva permisos y no modifica el índice", async (t) => {
  const f = fixture(t), mode = fs.statSync(f.ledgerPath).mode & 0o777;
  const before = snapshot(f.root), original = fs.readFileSync(f.ledgerPath, "utf8");
  const r = await f.record({ apply: true });
  assert.equal(r.status, "recorded"); assert.equal(r.wrote, true);
  assert.match(fs.readFileSync(f.ledgerPath, "utf8"), /\| \[#42\].*Sin cambios documentales \| — \|/);
  const after = snapshot(f.root), name = path.relative(f.root, f.ledgerPath);
  delete before[name]; delete after[name]; assert.deepEqual(after, before);
  assert.equal(fs.statSync(f.ledgerPath).mode & 0o777, mode); assert.deepEqual(artifacts(f), []);
  assert(original.endsWith("Conservar esta sección.\n"));
  assert(readReviewedPullRequests(f.ledgerPath, "owner/project").has(42));
});
test("record conserva modos POSIX específicos", posixPermissions, async (t) => {
  const f = fixture(t); fs.chmodSync(f.ledgerPath, 0o640);
  assert.equal((await f.record({ apply: true })).status, "recorded");
  assert.equal(fs.statSync(f.ledgerPath).mode & 0o777, 0o640);
});

test("repetir apply sin commit devuelve unchanged y no duplica ni cambia fecha", async (t) => {
  const f = fixture(t); await f.record({ apply: true }); const before = snapshot(f.root);
  const r = await f.record({ apply: true }, { clock: () => Date.parse("2026-10-02T12:00:00Z") });
  assert.equal(r.status, "unchanged"); assert.equal(r.date, "2026-10-01"); assert.equal(r.wrote, false);
  assert.deepEqual(snapshot(f.root), before);
});

test("no-op después de commit no exige que las notas sigan modificadas", async (t) => {
  const f = fixture(t); f.changeNote(); await f.record({ ...updated(), apply: true });
  f.commit(NOTE, LEDGER_PATH); const before = snapshot(f.root);
  const r = await f.record({ ...updated(), apply: true });
  assert.equal(r.status, "unchanged"); assert.deepEqual(snapshot(f.root), before);
});

test("no-op confirma identidad pero no aprueba retrospectivamente CI nuevo", async (t) => {
  const f = fixture(t, { rows: [defaultRow()], checks: [] });
  const before = snapshot(f.root); assert.equal((await f.record({ apply: true })).status, "unchanged");
  assert.deepEqual(snapshot(f.root), before);
});

test("notas actualizadas permite únicamente rutas exactas y no las escribe", async (t) => {
  const f = fixture(t); f.changeNote(); const before = fs.readFileSync(f.notePath);
  const r = await f.record({ ...updated(), apply: true });
  assert.equal(r.status, "recorded"); assert.deepEqual(fs.readFileSync(f.notePath), before);
  assert.match(fs.readFileSync(f.ledgerPath, "utf8"), /Actualizar el contexto; Notas: 03-IMPLEMENTACION\/Implementación.md/);
});

test("admite una nota nueva sin agregarla al índice", async (t) => {
  const f = fixture(t), name = "03-IMPLEMENTACION/Nueva.md";
  fs.writeFileSync(path.join(f.vault, name), "# Nueva\n");
  const index = fs.readFileSync(path.join(f.vault, ".git/index"));
  assert.equal((await f.record({ ...updated([name]), apply: true })).status, "recorded");
  assert.deepEqual(fs.readFileSync(path.join(f.vault, ".git/index")), index);
});

test("notas staged y unstaged se validan sin cambiar el staging", async (t) => {
  const f = fixture(t); f.changeNote(); git(f.vault, "add", "--", NOTE);
  f.changeNote("# Implementación\n\nContexto más reciente.\n"); const before = fs.readFileSync(path.join(f.vault, ".git/index"));
  assert.equal((await f.record({ ...updated(), apply: true })).status, "recorded");
  assert.deepEqual(fs.readFileSync(path.join(f.vault, ".git/index")), before);
});

for (const options of [
  { pr: 0 }, { pr: "1e2" }, { pr: "042" }, { pr: Number.MAX_SAFE_INTEGER + 1 }, { reviewed: false },
  { outcome: "unknown" }, { summary: "No permitido" }, { notes: [NOTE] }, { apply: "yes" },
  { outcome: "documentation-updated", summary: "Falta nota" }, { ...updated(), summary: "" },
  { ...updated(), summary: "x".repeat(301) }, { ...updated(), summary: "mal | contenido" },
  { ...updated(), summary: "[enlace](https://outside.invalid)" }, { ...updated(), summary: "token = abcdefghijklmnop" },
  { ackWarnings: ["doctor-warning"] }, { ackWarnings: ["unknown"] }, { unknown: true }
]) test(`entrada inválida rechazada antes de consultar o escribir (${JSON.stringify(options).slice(0, 85)})`, async (t) => {
  const f = fixture(t), before = snapshot(f.root);
  await assert.rejects(f.record(options), (e) => e.code === "invalid-option");
  assert.equal(f.calls.length, 0); assert.deepEqual(snapshot(f.root), before);
});

for (const note of ["../outside.md", "/outside.md", "03-IMPLEMENTACION/*.md", "03-IMPLEMENTACION/../Otra.md",
  ".obsidian/config.md", "07-AGENTES/skills/project/SKILL.md", "07-AGENTES/credentials/info.md",
  "03-IMPLEMENTACION//Otra.md", "03-IMPLEMENTACION/otra|nota.md", "03-IMPLEMENTACION/nota\n.md", LEDGER_PATH]) {
  test(`ruta prohibida de nota: ${JSON.stringify(note)}`, async (t) => {
    const f = fixture(t), before = snapshot(f.root);
    await assert.rejects(f.record(updated([note])), (e) => e.code === "invalid-option");
    assert.equal(f.calls.length, 0); assert.deepEqual(snapshot(f.root), before);
  });
}

for (const [name, setup] of [
  ["nota declarada sin cambios", () => {}],
  ["archivo ajeno", (f) => { f.changeNote(); fs.writeFileSync(path.join(f.vault, "foreign.txt"), "Trabajo ajeno.\n"); }],
  ["nota borrada", (f) => fs.unlinkSync(f.notePath)],
  ["nota renombrada", (f) => { fs.renameSync(f.notePath, path.join(f.vault, "03-IMPLEMENTACION/Renamed.md")); git(f.vault, "add", "--", NOTE, "03-IMPLEMENTACION/Renamed.md"); }],
  ["ledger editado a mano", (f) => { f.changeNote(); fs.appendFileSync(f.ledgerPath, "\nCambio ajeno.\n"); }]
]) test(`bloquea ${name} sin escribir`, async (t) => {
  const f = fixture(t); setup(f); const before = snapshot(f.root);
  await assert.rejects(f.record({ ...updated(), apply: true })); assert.deepEqual(snapshot(f.root), before);
});

test("sin cambios documentales rechaza un cambio local aunque parezca inocuo", async (t) => {
  const f = fixture(t); f.changeNote(); const before = snapshot(f.root);
  await assert.rejects(f.record({ apply: true }), (e) => e.code === "foreign-changes");
  assert.deepEqual(snapshot(f.root), before);
});

test("un cambio ajeno en fuente queda intacto y no invalida evidencia remota", async (t) => {
  const f = fixture(t); fs.appendFileSync(path.join(f.source, "source.txt"), "Trabajo en curso.\n");
  const before = snapshot(f.source); assert.equal((await f.record({ apply: true })).status, "recorded");
  assert.deepEqual(snapshot(f.source), before);
});

for (const text of ["# Nota\n\npassword = abcdefghijklmnop\n", "# Nota  \n", "# Nota sin fin", "# Nota\n[[Inexistente]]\n", "# Nota\n[Fuera](../../outside.md)\n"]) {
  test("validación de nota bloquea secretos, formato o enlaces sin divulgar texto", async (t) => {
    const f = fixture(t); f.changeNote(text); const before = snapshot(f.root);
    await assert.rejects(f.record({ ...updated(), apply: true }), (e) => { assert(!JSON.stringify(recordErrorReport(e)).includes("abcdefghijklmnop")); return true; });
    assert.deepEqual(snapshot(f.root), before);
  });
}

test("se revisa también el contenido staged, no solo la nota actual", async (t) => {
  const f = fixture(t); f.changeNote("# Nota\npassword = abcdefghijklmnop\n"); git(f.vault, "add", "--", NOTE);
  f.changeNote(); const before = snapshot(f.root);
  await assert.rejects(f.record({ ...updated(), apply: true }), (e) => e.code === "sensitive-diff");
  assert.deepEqual(snapshot(f.root), before);
});

for (const where of ["ledger", "note", "parent", "vault", "manifest"]) test(`rechaza symlink en ${where}`, ["parent", "vault"].includes(where) ? {} : fileSymlinks, async (t) => {
  const f = fixture(t);
  const file = where === "ledger" ? f.ledgerPath : where === "note" ? f.notePath : where === "manifest" ? f.manifestPath
    : where === "vault" ? f.vault : path.dirname(f.notePath);
  const moved = path.join(f.root, `moved-${where}`); fs.renameSync(file, moved);
  fs.symlinkSync(moved, file, ["parent", "vault"].includes(where) ? (process.platform === "win32" ? "junction" : "dir") : "file");
  try {
    const before = snapshot(f.root); await assert.rejects(f.record({ ...(where === "note" || where === "parent" ? updated() : {}), apply: true }));
    assert.deepEqual(snapshot(f.root), before);
  } finally { fs.unlinkSync(file); }
});

for (const [name, rows] of [
  ["duplicados", [defaultRow(1), defaultRow(1)]],
  ["otro repositorio", [defaultRow(1).replace("owner/project", "other/project")]],
  ["fecha imposible", [defaultRow(1).replace("2026-10-01", "2026-02-30")]],
  ["fila incompleta", ["| [#1](https://github.com/owner/project/pull/1) | Revisado | 2026-10-01 | | — |"]],
  ["columna adicional", [defaultRow(1) + " Extra |"]],
  ["estado desconocido", [defaultRow(1).replace("Revisado", "Sorpresa")]]
]) test(`tabla incompatible: ${name}`, async (t) => {
  const f = fixture(t, { rows }); const before = snapshot(f.root);
  await assert.rejects(f.record({ apply: true }), (e) => e.code === "invalid-ledger");
  assert.deepEqual(snapshot(f.root), before);
});

test("tabla duplicada y tabla ausente se rechazan", async (t) => {
  for (const ledger of ["# Sin tabla\n", `${HEADER}\n${SEPARATOR}\n\n${HEADER}\n${SEPARATOR}\n`]) {
    const f = fixture(t, { ledger }); const before = snapshot(f.root);
    await assert.rejects(f.record({ apply: true }), (e) => e.code === "invalid-ledger"); assert.deepEqual(snapshot(f.root), before);
  }
});

for (const legacy of [false, true]) test(`preserva frontmatter, CRLF y encabezado ${legacy ? "legado" : "canónico"}`, async (t) => {
  const table = ["---", "tipo: control", "---", "", "# Registro", legacy ? LEGACY : HEADER, SEPARATOR, defaultRow(1), "", "## Otra sección", "Texto.\n"].join("\n").replaceAll("\n", "\r\n");
  const f = fixture(t, { ledger: table, autocrlf: true }); await f.record({ apply: true });
  const expected = appendLedgerRecord(parseWritableLedger(table, "owner/project"), { repository: "owner/project", pr: 42, date: "2026-10-01", result: "Sin cambios documentales" });
  assert.equal(fs.readFileSync(f.ledgerPath, "utf8"), expected);
  assert(!/(?<!\r)\n/.test(expected)); assert(readReviewedPullRequests(f.ledgerPath, "owner/project").has(42));
  assert.equal((await f.record({ apply: true })).status, "unchanged");
});
test("record exige staging byte-exacto aunque solo difieran los saltos de línea", async (t) => {
  const f = fixture(t, { autocrlf: true });
  git(f.vault, "config", "core.autocrlf", "false");
  fs.writeFileSync(f.ledgerPath, fs.readFileSync(f.ledgerPath, "utf8").replaceAll("\n", "\r\n"));
  git(f.vault, "add", "--", LEDGER_PATH);
  await assert.rejects(f.record({ apply: true }), (e) => e.code === "dirty-ledger");
});

test("tabla ilustrativa en código no cuenta como una tabla real", async (t) => {
  const original = `${HEADER}\n${SEPARATOR}\n\n## Ejemplo\n\n${"```"}markdown\n${HEADER}\n${SEPARATOR}\n${"```"}\n`;
  const f = fixture(t, { ledger: original });
  await f.record({ apply: true }); assert(fs.readFileSync(f.ledgerPath, "utf8").endsWith(`${HEADER}\n${SEPARATOR}\n${"```"}\n`));
});

for (const illustration of [`<!--\n${HEADER}\n${SEPARATOR}\n-->\n`, `    ${HEADER}\n    ${SEPARATOR}\n`]) {
  test("tablas en comentarios o código indentado no son registros", async (t) => {
    const f = fixture(t, { ledger: `${HEADER}\n${SEPARATOR}\n\n## Ejemplo\n${illustration}` });
    await f.record({ apply: true }); assert(fs.readFileSync(f.ledgerPath, "utf8").endsWith(illustration));
    const g = fixture(t, { ledger: illustration }), before = snapshot(g.root);
    await assert.rejects(g.record({ apply: true }), (e) => e.code === "invalid-ledger");
    assert.deepEqual(snapshot(g.root), before);
  });
}

test("saltos de línea mezclados o comentario sin cerrar bloquean", async (t) => {
  for (const ledger of [`${HEADER}\r\n${SEPARATOR}\n`, `${HEADER}\n${SEPARATOR}\n<!-- sin cerrar\n`]) {
    const f = fixture(t, { ledger }), before = snapshot(f.root);
    await assert.rejects(f.record({ apply: true }), (e) => e.code === "invalid-ledger");
    assert.deepEqual(snapshot(f.root), before);
  }
});

test("preserva BOM y aplica sobre tabla sin salto final", async (t) => {
  for (const ledger of [`\uFEFF---\ntipo: control\n---\n${HEADER}\n${SEPARATOR}\n`, `${HEADER}\n${SEPARATOR}`]) {
    const f = fixture(t, { ledger }); await f.record({ apply: true });
    const first = fs.readFileSync(f.ledgerPath); const before = snapshot(f.root);
    assert(first.subarray(0, Buffer.byteLength(ledger)).equals(Buffer.from(ledger)));
    assert.equal((await f.record({ apply: true })).status, "unchanged"); assert.deepEqual(snapshot(f.root), before);
  }
});

for (const rows of [[defaultRow(42, "Otro resultado")], [defaultRow().replace("Revisado", "Pendiente")]]) test("registro previo distinto o pendiente produce conflict", async (t) => {
  const f = fixture(t, { rows }), before = snapshot(f.root);
  await assert.rejects(f.record({ apply: true }), (e) => e.code === "record-conflict"); assert.deepEqual(snapshot(f.root), before);
});

for (const pr of [{ state: "OPEN", mergedAt: null }, { baseRefName: "main" }, { mergeCommit: null }, { url: "https://github.com/other/project/pull/42" }]) {
  test("PR no integrado o identidad incorrecta impide escritura", async (t) => {
    const f = fixture(t, { pr }), before = snapshot(f.root);
    await assert.rejects(f.record({ apply: true }), (e) => e.code === "inspection-error"); assert.deepEqual(snapshot(f.root), before);
  });
}

for (const conclusion of ["failure", "cancelled", "neutral", "skipped", "unknown"]) test(`CI ${conclusion} bloquea un registro nuevo`, async (t) => {
  const f = fixture(t, { checks: [{ id: 1, app: { id: 1 }, name: "Tests", status: "completed", conclusion, head_sha: HEAD,
    html_url: "https://github.com/owner/project/actions/runs/1", completed_at: DATE }] });
  const before = snapshot(f.root); await assert.rejects(f.record({ apply: true }), (e) => e.code === "evidence-blocked"); assert.deepEqual(snapshot(f.root), before);
});

test("sin CI, CI pendiente e inventario incompleto bloquean", async (t) => {
  for (const options of [{ checks: [] }, { checks: [{ id: 1, app: { id: 1 }, name: "Tests", status: "in_progress", conclusion: null, head_sha: HEAD, html_url: null, started_at: DATE }] }, { pr: { changedFiles: 2 } }]) {
    const f = fixture(t, options), before = snapshot(f.root);
    await assert.rejects(f.record({ apply: true }), (e) => e.code === "evidence-blocked"); assert.deepEqual(snapshot(f.root), before);
  }
});

test("solo se aceptan explícitamente text-limit y unsafe-reference observadas", async (t) => {
  const f = fixture(t, { pr: { body: "x".repeat(4001) }, checkUrl: "https://outside.invalid/result" });
  const before = snapshot(f.root);
  await assert.rejects(f.record({ apply: true }), (e) => e.code === "evidence-blocked"); assert.deepEqual(snapshot(f.root), before);
  const r = await f.record({ apply: true, ackWarnings: ["text-limit", "unsafe-reference"] });
  assert.equal(r.status, "recorded"); assert.deepEqual(r.acknowledgedWarnings, ["text-limit", "unsafe-reference"]);
});

test("aceptar advertencia ausente no concede permisos genéricos", async (t) => {
  const f = fixture(t), before = snapshot(f.root);
  await assert.rejects(f.record({ apply: true, ackWarnings: ["text-limit"] }), (e) => e.code === "invalid-option"); assert.deepEqual(snapshot(f.root), before);
});

test("doctor-warning distinto de suciedad validada nunca se descuenta", async (t) => {
  const f = fixture(t, { doctorChecks: [{ id: "git-upstream", level: "warning" }] }); f.changeNote(); const before = snapshot(f.root);
  await assert.rejects(f.record({ ...updated(), apply: true }), (e) => e.code === "doctor-warning"); assert.deepEqual(snapshot(f.root), before);
});

test("doctor error bloquea y sus detalles no se copian", async (t) => {
  const f = fixture(t, { doctorStatus: "error" }), before = snapshot(f.root);
  await assert.rejects(f.record({ apply: true }), (e) => e.code === "doctor-error"); assert.deepEqual(snapshot(f.root), before);
});

for (const what of ["ledger", "manifest", "note", "index", "foreign"]) test(`cambio concurrente durante consulta: ${what}`, async (t) => {
  let changed = false;
  const f = fixture(t, { onQuery({ args, ledgerPath, manifestPath, notePath, vault }) {
    if (changed || args[0] !== "pr") return; changed = true;
    if (what === "ledger") fs.appendFileSync(ledgerPath, "\nEdición concurrente.\n");
    else if (what === "manifest") fs.appendFileSync(manifestPath, " ");
    else if (what === "note") fs.appendFileSync(notePath, "Otra edición.\n");
    else if (what === "index") git(vault, "config", "core.filemode", "false");
    else fs.writeFileSync(path.join(vault, "foreign.txt"), "Ajeno\n");
  } });
  if (what === "note") f.changeNote();
  // For index mutation, force a real index difference without staging a file.
  if (what === "index") f.context.runCommand = ((original) => (cmd, args, limits) => {
    if (!changed && args[0] === "pr") { git(f.vault, "update-index", "--assume-unchanged", "--", NOTE); changed = true; }
    return original(cmd, args, limits);
  })(f.context.runCommand);
  const originalLedger = fs.readFileSync(f.ledgerPath, "utf8");
  await assert.rejects(f.record({ ...(what === "note" ? updated() : {}), apply: true }), (e) => e.code === "concurrent-change");
  assert.equal(fs.readFileSync(f.ledgerPath, "utf8"), what === "ledger" ? originalLedger + "\nEdición concurrente.\n" : originalLedger);
  assert.deepEqual(artifacts(f), []);
});

test("bloqueo existente no se elimina ni sobrescribe", async (t) => {
  const f = fixture(t), lock = path.join(path.dirname(f.ledgerPath), ".project-memory-sync-record.lock");
  fs.writeFileSync(lock, "Otro propietario\n"); const before = snapshot(f.root);
  await assert.rejects(f.record({ apply: true })); assert.deepEqual(snapshot(f.root), before);
});

for (const failure of ["write", "rename"]) test(`fallo de ${failure} conserva ledger y limpia temporales propios`, async (t) => {
  const f = fixture(t), before = snapshot(f.root);
  const operations = { ...fs, ...(failure === "write" ? { writeFileSync() { throw new Error("ENOSPC private detail"); } }
    : { renameSync() { throw new Error("EACCES private detail"); } }) };
  await assert.rejects(f.record({ apply: true }, { fileOperations: operations }), (e) => e.code === "write-error");
  assert.deepEqual(snapshot(f.root), before); assert.deepEqual(artifacts(f), []);
});

test("cambio después del plan y antes del reemplazo se conserva", async (t) => {
  const f = fixture(t), original = fs.readFileSync(f.ledgerPath, "utf8");
  await assert.rejects(f.record({ apply: true }, { fileOperations: { ...fs, writeFileSync(fd, text, encoding) {
    fs.writeFileSync(fd, text, encoding); fs.appendFileSync(f.ledgerPath, "\nEdición durante escritura.\n");
  } } }), (e) => e.code === "concurrent-change");
  assert.equal(fs.readFileSync(f.ledgerPath, "utf8"), original + "\nEdición durante escritura.\n"); assert.deepEqual(artifacts(f), []);
});

test("temporal modificado no se instala en el ledger", async (t) => {
  const f = fixture(t), original = fs.readFileSync(f.ledgerPath);
  await assert.rejects(f.record({ apply: true }, { fileOperations: { ...fs, writeFileSync(fd) { fs.writeFileSync(fd, "Contenido sustituido\n"); } } }), (e) => e.code === "artifact-conflict");
  assert.deepEqual(fs.readFileSync(f.ledgerPath), original); assert.deepEqual(artifacts(f), []);
});

test("fallo de limpieza posterior informa wrote true y no revierte", async (t) => {
  const f = fixture(t);
  const r = await f.record({ apply: true }, { fileOperations: { ...fs, unlinkSync() { throw new Error("private cleanup detail"); } } });
  assert.equal(r.status, "error"); assert.equal(r.wrote, true); assert.equal(r.code, "cleanup-error");
  assert.match(fs.readFileSync(f.ledgerPath, "utf8"), /\[#42\]/); assert.equal(artifacts(f).length, 1);
  assert(!JSON.stringify(r).includes("private cleanup detail"));
});

test("error comunicado después de rename no oculta que la fila se guardó", async (t) => {
  const f = fixture(t);
  const r = await f.record({ apply: true }, { fileOperations: { ...fs, renameSync(from, to) { fs.renameSync(from, to); throw new Error("after rename"); } } });
  assert.equal(r.status, "error"); assert.equal(r.wrote, true); assert.equal(r.code, "write-confirmation-error"); assert.deepEqual(artifacts(f), []);
});

test("archivo de ledger o manifiesto demasiado grande se rechaza sin truncar", async (t) => {
  for (const file of ["ledgerPath", "manifestPath"]) {
    const f = fixture(t); fs.writeFileSync(f[file], "x".repeat(RECORD_LIMITS.ledger + 1)); const before = snapshot(f.root);
    await assert.rejects(f.record({ apply: true }), (e) => e.code === "file-limit"); assert.deepEqual(snapshot(f.root), before);
  }
});

test("nota demasiado grande se rechaza aunque doctor la omita", async (t) => {
  const f = fixture(t); f.changeNote("x".repeat(RECORD_LIMITS.note + 1)); const before = snapshot(f.root);
  await assert.rejects(f.record({ ...updated(), apply: true }), (e) => e.code === "file-limit"); assert.deepEqual(snapshot(f.root), before);
});

for (const flag of ["--assume-unchanged", "--skip-worktree"]) test(`no confía en limpieza con ${flag}`, async (t) => {
  const f = fixture(t); git(f.vault, "update-index", flag, "--", LEDGER_PATH);
  fs.appendFileSync(f.ledgerPath, "\nCambio oculto a Git.\n"); const before = snapshot(f.root);
  await assert.rejects(f.record({ apply: true }), (e) => e.code === "hidden-git-changes");
  assert.deepEqual(snapshot(f.root), before); assert.equal(f.calls.length, 0);
});

test("un índice con nota simbólica no se aprueba por tener un archivo regular en disco", async (t) => {
  const f = fixture(t), name = "03-IMPLEMENTACION/Nueva.md", file = path.join(f.vault, name);
  // Stage a real Git symlink entry independently of filesystem symlink privileges.
  const blob = execFileSync("git", ["-C", f.vault, "hash-object", "-w", "--stdin"], { input: f.ledgerPath, encoding: "utf8" }).trim();
  git(f.vault, "update-index", "--add", "--cacheinfo", `120000,${blob},${name}`);
  assert.match(git(f.vault, "ls-files", "--stage", "--", name), /^120000 /u);
  fs.writeFileSync(file, "# Nueva\n");
  const before = snapshot(f.root);
  await assert.rejects(f.record({ ...updated([name]), apply: true }), (e) => ["staged-type", "foreign-changes"].includes(e.code));
  assert.deepEqual(snapshot(f.root), before);
});

test("repetir no-op no aprueba una edición ajena del ledger en staging", async (t) => {
  const f = fixture(t); await f.record({ apply: true });
  const recorded = fs.readFileSync(f.ledgerPath);
  fs.appendFileSync(f.ledgerPath, "\nEdición ajena preparada para commit.\n"); git(f.vault, "add", "--", LEDGER_PATH);
  fs.writeFileSync(f.ledgerPath, recorded); const before = snapshot(f.root);
  await assert.rejects(f.record({ apply: true }), (e) => e.code === "dirty-ledger");
  assert.deepEqual(snapshot(f.root), before);
});

test("rechaza texto UTF-8 inválido en disco y en staging", async (t) => {
  for (const staged of [false, true]) {
    const f = fixture(t); fs.writeFileSync(f.notePath, Buffer.from([0xff, 0x0a]));
    if (staged) { git(f.vault, "add", "--", NOTE); f.changeNote(); }
    const before = snapshot(f.root);
    await assert.rejects(f.record({ ...updated(), apply: true }), (e) => e.code === (staged ? "git-error" : "invalid-text"));
    assert.deepEqual(snapshot(f.root), before);
  }
});

test("límite total de notas se comprueba sobre todo el contenido", async (t) => {
  const f = fixture(t), notes = Array.from({ length: 6 }, (_, i) => `03-IMPLEMENTACION/Grande-${i}.md`);
  for (const note of notes) fs.writeFileSync(path.join(f.vault, note), "x".repeat(900_000) + "\n");
  const before = snapshot(f.root);
  await assert.rejects(f.record({ ...updated(notes), apply: true }), (e) => e.code === "notes-limit");
  assert.deepEqual(snapshot(f.root), before); assert.equal(f.calls.length, 0);
});

test("no omite secretos al final de una nota próxima al límite", async (t) => {
  const f = fixture(t); f.changeNote("x".repeat(1_000_001) + "\npassword = abcdefghijklmnop\n");
  const before = snapshot(f.root);
  await assert.rejects(f.record({ ...updated(), apply: true }), (e) => e.code === "sensitive-note");
  assert.deepEqual(snapshot(f.root), before);
});

test("limita cantidad de notas antes de leer archivos o consultar", async (t) => {
  const f = fixture(t), before = snapshot(f.root);
  await assert.rejects(f.record(updated(Array.from({ length: 21 }, (_, i) => `03-IMPLEMENTACION/N-${i}.md`))), (e) => e.code === "invalid-option");
  assert.deepEqual(snapshot(f.root), before); assert.equal(f.calls.length, 0);
});

test("un bloqueo ignorado por Git sigue impidiendo el segundo escritor", async (t) => {
  const f = fixture(t), lock = path.join(path.dirname(f.ledgerPath), ".project-memory-sync-record.lock");
  fs.writeFileSync(path.join(f.vault, ".gitignore"), ".project-memory-sync-record*\n"); f.commit(".gitignore");
  fs.writeFileSync(lock, "Otro escritor\n"); const before = snapshot(f.root);
  await assert.rejects(f.record({ apply: true }), (e) => e.code === "record-locked");
  assert.deepEqual(snapshot(f.root), before);
});

test("la limpieza conserva un bloqueo sustituido por otro propietario", async (t) => {
  const f = fixture(t), lock = path.join(path.dirname(f.ledgerPath), ".project-memory-sync-record.lock");
  const original = fs.readFileSync(f.ledgerPath), replacement = path.join(f.root, "replacement.lock");
  fs.writeFileSync(replacement, "Propietario nuevo\n");
  await assert.rejects(f.record({ apply: true }, { fileOperations: { ...fs, writeFileSync(fd, text, encoding) {
    fs.writeFileSync(fd, text, encoding); fs.renameSync(replacement, lock);
  } } }), (e) => e.code === "cleanup-error");
  assert.deepEqual(fs.readFileSync(f.ledgerPath), original);
  assert.equal(fs.readFileSync(lock, "utf8"), "Propietario nuevo\n"); assert.equal(artifacts(f).length, 1);
});

test("errores sensibles del proveedor nunca llegan al informe", async (t) => {
  const f = fixture(t, { providerError: Object.assign(new Error("password = abcdefghijklmnop"), { stderr: "gh auth login token = abcdefghijklmnop" }) });
  try { await f.record({ apply: true }); assert.fail("Debe bloquear"); }
  catch (error) { assert.equal(error.code, "inspection-error"); assert(!JSON.stringify(recordErrorReport(error)).includes("abcdefghijklmnop")); }
});

test("integración con doctor real: preview y apply cumplen los límites", async (t) => {
  const f = fixture(t); const context = { ...f.context }; delete context.diagnoseMemory;
  const before = snapshot(f.root);
  assert.equal((await recordMemorySync(f.input, context)).status, "preview"); assert.deepEqual(snapshot(f.root), before);
  f.changeNote(); assert.equal((await recordMemorySync({ ...f.input, ...updated(), apply: true }, context)).status, "recorded");
});

test("CLI usa JSON, códigos, aplicación explícita y opciones no contradictorias", async (t) => {
  const f = fixture(t);
  const base = ["sync", "record", f.vault, "--pr", "42", "--outcome", "no-documentation-change", "--reviewed", "--json"];
  for (const extra of [["--push"], ["--strict"], ["--pr", "43"], ["--summary"], ["--ack-warning", "doctor-warning"]]) {
    const out = [], err = []; const before = snapshot(f.root);
    assert.equal(await runCli([...base, ...extra], { out: (s) => out.push(s), err: (s) => err.push(s) }, f.context), 2);
    assert.equal(JSON.parse(out[0]).wrote, false); assert.deepEqual(snapshot(f.root), before);
  }
  for (const [extra, status] of [[[], "preview"], [["--apply"], "recorded"], [["--apply"], "unchanged"]]) {
    const out = [];
    assert.equal(await runCli([...base, ...extra], { out: (s) => out.push(s), err: () => {} }, f.context), 0);
    assert.equal(JSON.parse(out[0]).status, status);
  }
});

test('record accepts the same Windows vault with different path casing', {skip: process.platform !== 'win32'}, async t => {
 const f=fixture(t);
 const diagnoseMemory=async()=>({...await f.context.diagnoseMemory(),vaultPath:f.vault.toUpperCase()});
 const result=await f.record({}, {diagnoseMemory});
 assert.equal(result.status,'preview');
});
