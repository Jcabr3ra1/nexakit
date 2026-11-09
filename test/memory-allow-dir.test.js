import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { allowMemoryDirectory } from "../src/memory-allow-dir.js";
import { initializeMemory } from "../src/init.js";

function createFixture(context) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "project-memory-allow-")));
  const source = path.join(root, "source");
  const memory = path.join(root, "memory");
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "README.md"), "# Demo\n");
  execFileSync("git", ["-C", source, "init", "-q"]);
  // Sin exclusiones globales: las de quien ejecute la prueba (Claude Code añade las suyas) ocultarían el cambio.
  execFileSync("git", ["-C", source, "config", "core.excludesFile", path.join(root, "sin-exclusiones")]);
  initializeMemory(
    { destination: memory, projectId: "demo-project", projectName: "Demo Project", sourcePath: source, apply: true },
    { now: new Date("2026-09-29T12:00:00Z") }
  );
  const settings = path.join(source, ".claude", "settings.local.json");
  const exclude = path.join(source, ".git", "info", "exclude");
  return { root, source, memory, settings, exclude };
}

const readSettings = (fixture) => JSON.parse(fs.readFileSync(fixture.settings, "utf8"));

test("sin --apply solo previsualiza y no escribe nada", async (context) => {
  const fixture = createFixture(context);
  const report = await allowMemoryDirectory({ targetPath: fixture.memory });
  assert.equal(report.status, "preview");
  assert.equal(report.vaultPath, fixture.memory);
  assert.equal(report.settingsPath, fixture.settings);
  assert.deepEqual(report.changes.map((change) => change.id), ["additionalDirectories", "gitExclude"]);
  assert.equal(fs.existsSync(path.join(fixture.source, ".claude")), false);
});

test("--apply crea el archivo local con la bóveda y lo excluye de git sin tocar el repositorio", async (context) => {
  const fixture = createFixture(context);
  const report = await allowMemoryDirectory({ targetPath: fixture.memory, apply: true });
  assert.equal(report.status, "applied");
  assert.deepEqual(readSettings(fixture), { permissions: { additionalDirectories: [fixture.memory] } });
  assert.match(fs.readFileSync(fixture.exclude, "utf8"), /^\.claude\/settings\.local\.json$/mu);
  assert.equal(execFileSync("git", ["-C", fixture.source, "status", "--porcelain"], { encoding: "utf8" }).includes(".claude"), false);
});

test("conserva lo que ya había en el archivo y no duplica la carpeta", async (context) => {
  const fixture = createFixture(context);
  fs.mkdirSync(path.dirname(fixture.settings), { recursive: true });
  fs.writeFileSync(fixture.settings, JSON.stringify({
    model: "opus",
    permissions: { allow: ["Bash(npm test)"], additionalDirectories: ["/otra/carpeta"], blockReadsOutsideWorkingDirectories: true }
  }));
  await allowMemoryDirectory({ targetPath: fixture.memory, apply: true });
  const first = readSettings(fixture);
  assert.equal(first.model, "opus");
  assert.deepEqual(first.permissions.allow, ["Bash(npm test)"]);
  assert.equal(first.permissions.blockReadsOutsideWorkingDirectories, true, "no se quita el bloqueo del usuario");
  assert.deepEqual(first.permissions.additionalDirectories, ["/otra/carpeta", fixture.memory]);
  const again = await allowMemoryDirectory({ targetPath: fixture.memory, apply: true });
  assert.equal(again.status, "unchanged");
  assert.deepEqual(readSettings(fixture), first);
  assert.equal(fs.readFileSync(fixture.exclude, "utf8").match(/settings\.local\.json/gu).length, 1, "la exclusión no se repite");
});

test("un archivo que no es JSON válido es un conflicto y no se toca", async (context) => {
  const fixture = createFixture(context);
  fs.mkdirSync(path.dirname(fixture.settings), { recursive: true });
  fs.writeFileSync(fixture.settings, "{ esto no es json");
  const report = await allowMemoryDirectory({ targetPath: fixture.memory, apply: true });
  assert.equal(report.status, "conflict");
  assert.match(report.reasons.join(" "), /JSON/u);
  assert.equal(fs.readFileSync(fixture.settings, "utf8"), "{ esto no es json");
});

test("un archivo que git ya sigue es un conflicto: la ruta personal acabaría en el repositorio", async (context) => {
  const fixture = createFixture(context);
  fs.mkdirSync(path.dirname(fixture.settings), { recursive: true });
  fs.writeFileSync(fixture.settings, "{}\n");
  execFileSync("git", ["-C", fixture.source, "add", "-f", ".claude/settings.local.json"]);
  const report = await allowMemoryDirectory({ targetPath: fixture.memory, apply: true });
  assert.equal(report.status, "conflict");
  assert.match(report.reasons.join(" "), /git/u);
  assert.equal(fs.readFileSync(fixture.settings, "utf8"), "{}\n");
});

test("una carpeta .claude que es un enlace simbólico es un conflicto", async (context) => {
  const fixture = createFixture(context);
  const real = path.join(fixture.root, "claude-real");
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(fixture.source, ".claude"), process.platform === "win32" ? "junction" : "dir");
  const report = await allowMemoryDirectory({ targetPath: fixture.memory, apply: true });
  assert.equal(report.status, "conflict");
  assert.equal(fs.readdirSync(real).length, 0);
});

test("sin repositorio fuente existente no hay dónde escribir", async (context) => {
  const fixture = createFixture(context);
  fs.rmSync(fixture.source, { recursive: true, force: true });
  const report = await allowMemoryDirectory({ targetPath: fixture.memory, apply: true });
  assert.equal(report.status, "conflict");
  assert.match(report.reasons.join(" "), /repositorio/u);
});

test("la orden allow-dir de la CLI previsualiza, aplica y acepta --json", async (context) => {
  const fixture = createFixture(context);
  const out = [];
  const err = [];
  const io = { out: (text) => out.push(text), err: (text) => err.push(text) };
  assert.equal(await runCli(["allow-dir", fixture.memory], io), 0);
  assert.match(out.join("\n"), /PREVIEW/u);
  assert.equal(fs.existsSync(fixture.settings), false);
  out.length = 0;
  assert.equal(await runCli(["allow-dir", fixture.memory, "--apply", "--json"], io), 0);
  assert.equal(JSON.parse(out.join("\n")).status, "applied");
  assert.deepEqual(readSettings(fixture).permissions.additionalDirectories, [fixture.memory]);
  assert.equal(await runCli(["allow-dir", fixture.memory, "--agent", "codex"], io), 2, "solo existe para Claude Code");
  assert.equal(await runCli(["allow-dir", fixture.memory, "--raro"], io), 2);
  assert.deepEqual(err.length > 0, true);
});
