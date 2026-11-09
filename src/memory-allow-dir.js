import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { IS_WINDOWS } from "./platform.js";
import {
  ConnectionError,
  readJson,
  resolveConfiguredPath,
  resolveManifestPath,
  writeTextAtomic
} from "./connect.js";

// Claude Code solo lee y escribe fuera de la carpeta del proyecto si esa carpeta está declarada. Esta orden
// añade la bóveda de memoria a `permissions.additionalDirectories` del archivo LOCAL del proyecto
// (.claude/settings.local.json), que es personal: la ruta de tu equipo no debe llegar a un commit.
//
// Lo que concede: las lecturas de esa carpeta dejan de pedir permiso. Las ediciones siguen el modo de permisos
// de la sesión, así que en modo manual cada escritura sigue pidiéndolo. No toca los ajustes del usuario ni quita
// `blockReadsOutsideWorkingDirectories`: abre una sola carpeta, no desactiva la protección.

const SETTINGS_RELATIVE = [".claude", "settings.local.json"];
const SETTINGS_GIT_PATH = ".claude/settings.local.json";

const same = (left, right) =>
  IS_WINDOWS ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);

function git(repository, args) {
  const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", shell: false });
  return { status: result.status, stdout: (result.stdout ?? "").trim() };
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function conflict(report, reason) {
  report.status = "conflict";
  report.reasons.push(reason);
  return report;
}

function readSettings(settingsPath) {
  const info = lstatOrNull(settingsPath);
  if (!info) return { settings: {}, exists: false };
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ConnectionError([`${settingsPath} no es un archivo normal (enlace simbólico o carpeta).`]);
  }
  const settings = readJson(settingsPath, "los ajustes locales de Claude Code");
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new ConnectionError([`${settingsPath} debe contener un objeto JSON.`]);
  }
  return { settings, exists: true };
}

export async function allowMemoryDirectory(options = {}) {
  const target = path.resolve(options.targetPath ?? process.cwd());
  const manifestPath = resolveManifestPath(target, options.manifestPath);
  if (!manifestPath) throw new ConnectionError(["No se encontró project-memory.json."]);

  const manifest = readJson(manifestPath, "manifiesto");
  const manifestDirectory = path.dirname(manifestPath);
  if (typeof manifest?.memory?.vaultPath !== "string" || typeof manifest?.source?.repositoryPath !== "string") {
    throw new ConnectionError(["El manifiesto no declara memory.vaultPath y source.repositoryPath."]);
  }
  const vaultPath = resolveConfiguredPath(manifestDirectory, manifest.memory.vaultPath);
  const repository = resolveConfiguredPath(manifestDirectory, manifest.source.repositoryPath);
  const settingsPath = path.join(repository, ...SETTINGS_RELATIVE);

  const report = {
    command: "project-memory allow-dir",
    status: "preview",
    agent: "claude",
    vaultPath,
    repositoryPath: repository,
    settingsPath,
    changes: [],
    reasons: []
  };

  if (!isDirectory(vaultPath)) return conflict(report, `La bóveda no existe: ${vaultPath}`);
  if (!isDirectory(repository)) return conflict(report, `El repositorio fuente no existe: ${repository}`);

  const claudeDirectory = path.join(repository, SETTINGS_RELATIVE[0]);
  if (lstatOrNull(claudeDirectory)?.isSymbolicLink()) {
    return conflict(report, `${claudeDirectory} es un enlace simbólico: Claude Code trataría estos ajustes como del repositorio.`);
  }

  let current;
  try {
    current = readSettings(settingsPath);
  } catch (error) {
    if (!(error instanceof ConnectionError)) throw error;
    return conflict(report, error.details.join(" "));
  }

  const isRepository = git(repository, ["rev-parse", "--git-dir"]).status === 0;
  if (isRepository && git(repository, ["ls-files", "--error-unmatch", "--", SETTINGS_GIT_PATH]).status === 0) {
    return conflict(report, `git ya sigue ${SETTINGS_GIT_PATH}: la ruta de tu equipo acabaría en el repositorio. Deja de seguirlo antes (git rm --cached).`);
  }

  const directories = Array.isArray(current.settings.permissions?.additionalDirectories)
    ? current.settings.permissions.additionalDirectories
    : [];
  if (current.settings.permissions !== undefined &&
      (current.settings.permissions === null || typeof current.settings.permissions !== "object" || Array.isArray(current.settings.permissions))) {
    return conflict(report, `${settingsPath}: «permissions» no es un objeto.`);
  }
  const alreadyAllowed = directories.some((entry) => typeof entry === "string" && same(entry, vaultPath));
  if (!alreadyAllowed) report.changes.push({ id: "additionalDirectories", action: current.exists ? "update" : "create" });

  let excludePath = null;
  if (isRepository && git(repository, ["check-ignore", "-q", "--", SETTINGS_GIT_PATH]).status !== 0) {
    const resolved = git(repository, ["rev-parse", "--git-path", "info/exclude"]).stdout;
    excludePath = path.resolve(repository, resolved);
    report.changes.push({ id: "gitExclude", action: "update" });
  }

  if (report.changes.length === 0) {
    report.status = "unchanged";
    return report;
  }
  if (!options.apply) return report;

  if (!alreadyAllowed) {
    const next = {
      ...current.settings,
      permissions: { ...(current.settings.permissions ?? {}), additionalDirectories: [...directories, vaultPath] }
    };
    writeTextAtomic(settingsPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  if (excludePath) {
    fs.mkdirSync(path.dirname(excludePath), { recursive: true });
    const previous = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    const separator = previous === "" || previous.endsWith("\n") ? "" : "\n";
    fs.writeFileSync(excludePath, `${previous}${separator}${SETTINGS_GIT_PATH}\n`);
  }
  report.status = "applied";
  return report;
}
