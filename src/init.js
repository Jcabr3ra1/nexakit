import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = path.resolve(SOURCE_DIRECTORY, "../templates/project-memory");
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const KNOWN_AGENTS = ["codex", "claude", "antigravity"];
const BRANCH_PATTERN = /^(?!.*(?:\.\.|\/\/|@\{|\\))[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const SYNC_MODES = new Set(["none", "git-manual", "git-automated"]);

export function initializeMemory(options, context = {}) {
  const config = normalizeOptions(options, context);
  validateConfig(config);

  const generatedFiles = buildGeneratedFiles(config);
  const files = generatedFiles.map((file) => inspectTarget(config.destination, file));
  const conflicts = files.filter((file) => file.action === "conflict");
  const report = createReport(config, files, options.apply === true);

  if (conflicts.length > 0) {
    report.status = "conflict";
    return report;
  }

  if (!options.apply) {
    report.status = "preview";
    return report;
  }

  for (const file of files) {
    if (file.action !== "create") {
      continue;
    }

    fs.mkdirSync(path.dirname(file.absolutePath), { recursive: true });
    fs.writeFileSync(file.absolutePath, file.content, {
      encoding: "utf8",
      flag: "wx"
    });
  }

  report.status = files.some((file) => file.action === "create")
    ? "created"
    : "unchanged";
  return report;
}

function normalizeOptions(options, context) {
  const destination = resolvePhysicalPath(path.resolve(options.destination ?? ""));
  const sourcePath = resolvePhysicalPath(path.resolve(options.sourcePath ?? ""));
  const defaultBranch = options.defaultBranch ?? "main";
  const integrationBranch = options.integrationBranch ?? defaultBranch;
  const syncMode =
    options.syncMode ?? (options.memoryRemote ? "git-manual" : "none");
  const now = context.now ?? new Date();

  return {
    destinationProvided: Boolean(options.destination),
    sourceProvided: Boolean(options.sourcePath),
    projectId: options.projectId?.trim(),
    projectName: options.projectName?.trim(),
    description:
      options.description?.trim() ||
      `Memoria organizada y privada de ${options.projectName?.trim() ?? ""}.`,
    destination,
    sourcePath,
    sourceRemote: options.sourceRemote?.trim(),
    memoryRemote: options.memoryRemote?.trim(),
    defaultBranch,
    integrationBranch,
    memoryBranch: "main",
    mcpName: options.mcpName?.trim() || `${options.projectId?.trim()}-memory`,
    syncMode,
    agents: options.agents ?? ["codex", "claude"],
    date: formatDate(now),
    templateRoot: path.resolve(context.templateRoot ?? TEMPLATE_ROOT)
  };
}

function validateConfig(config) {
  const errors = [];

  if (
    !PROJECT_ID_PATTERN.test(config.projectId ?? "") ||
    config.projectId?.length < 2 ||
    config.projectId?.length > 64
  ) {
    errors.push("--project-id debe usar minúsculas, números y guiones.");
  }

  if (!Array.isArray(config.agents) || config.agents.length === 0 ||
    config.agents.some((agent) => !KNOWN_AGENTS.includes(agent)) ||
    new Set(config.agents).size !== config.agents.length) {
    errors.push("Los agentes deben ser codex, claude o antigravity, sin repetir.");
  }

  if (!config.projectName || config.projectName.length > 100) {
    errors.push("--project-name es obligatorio y admite máximo 100 caracteres.");
  }

  if (!config.destinationProvided) {
    errors.push("Debes indicar la ruta de destino.");
  }

  if (!config.sourceProvided) {
    errors.push("--source es obligatorio.");
  } else if (!isDirectory(config.sourcePath)) {
    errors.push("--source debe apuntar a un directorio existente.");
  } else if (!isGitRepository(config.sourcePath)) {
    errors.push("--source debe pertenecer a un repositorio Git.");
  }

  if (
    !BRANCH_PATTERN.test(config.defaultBranch) ||
    config.defaultBranch.length > 255
  ) {
    errors.push("--default-branch no es un nombre de rama válido.");
  }

  if (
    !BRANCH_PATTERN.test(config.integrationBranch) ||
    config.integrationBranch.length > 255
  ) {
    errors.push("--integration-branch no es un nombre de rama válido.");
  }

  if (!PROJECT_ID_PATTERN.test(config.mcpName) || config.mcpName.length > 80) {
    errors.push("--mcp-name debe usar minúsculas, números y guiones.");
  }

  if (config.description.length > 500) {
    errors.push("--description no puede superar 500 caracteres.");
  }

  if (!SYNC_MODES.has(config.syncMode)) {
    errors.push("--sync-mode debe ser none, git-manual o git-automated.");
  }

  if (config.sourceRemote && hasEmbeddedCredentials(config.sourceRemote)) {
    errors.push("--source-remote no puede contener credenciales.");
  }

  if (config.memoryRemote && hasEmbeddedCredentials(config.memoryRemote)) {
    errors.push("--memory-remote no puede contener credenciales.");
  }

  if (config.destination === path.parse(config.destination).root) {
    errors.push("El destino no puede ser la raíz del sistema de archivos.");
  }

  if (config.destination === path.resolve(os.homedir())) {
    errors.push("El destino no puede ser directamente el directorio personal.");
  }

  if (fs.existsSync(config.destination) && !isDirectory(config.destination)) {
    errors.push("El destino existente debe ser un directorio.");
  } else if (
    fs.existsSync(config.destination) &&
    fs.lstatSync(config.destination).isSymbolicLink()
  ) {
    errors.push("El destino no puede ser un enlace simbólico.");
  }

  if (
    isSameOrInside(config.sourcePath, config.destination) ||
    isSameOrInside(config.destination, config.sourcePath)
  ) {
    errors.push("El repositorio fuente y la memoria deben estar separados.");
  }

  if (!isDirectory(config.templateRoot)) {
    errors.push("No se encontró la plantilla canónica instalada.");
  }

  if (errors.length > 0) {
    throw new InitializationError(errors);
  }
}

function buildGeneratedFiles(config) {
  const replacements = {
    PROJECT_ID: config.projectId,
    PROJECT_NAME: config.projectName,
    SOURCE_REPOSITORY: path.basename(config.sourcePath),
    MEMORY_REPOSITORY: path.basename(config.destination),
    MCP_SERVER_NAME: config.mcpName,
    DEFAULT_BRANCH: config.defaultBranch,
    INTEGRATION_BRANCH: config.integrationBranch,
    DATE: config.date
  };
  const files = [];

  files.push({
    relativePath: "project-memory.json",
    content: `${JSON.stringify(createManifest(config), null, 2)}\n`
  });

  const vaultRoot = path.join(config.templateRoot, "vault");
  for (const sourcePath of collectFiles(vaultRoot)) {
    files.push({
      relativePath: normalizeRelativePath(path.relative(vaultRoot, sourcePath)),
      content: renderTemplate(fs.readFileSync(sourcePath, "utf8"), replacements)
    });
  }

  const skillRoot = path.join(config.templateRoot, "skill/project-id");
  for (const sourcePath of collectFiles(skillRoot)) {
    const rendered = renderTemplate(
      fs.readFileSync(sourcePath, "utf8"),
      replacements
    )
      .replaceAll("project-id", config.projectId)
      .replaceAll("Project Name", config.projectName);
    files.push({
      relativePath: normalizeRelativePath(
        path.join(
          "07-AGENTES/skills",
          config.projectId,
          path.relative(skillRoot, sourcePath)
        )
      ),
      content: rendered
    });
  }

  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
}

function createManifest(config) {
  const documentationPaths = ["README.md", "docs"].filter((candidate) =>
    fs.existsSync(path.join(config.sourcePath, candidate))
  );
  const source = {
    repositoryPath: config.sourcePath,
    defaultBranch: config.defaultBranch,
    integrationBranch: config.integrationBranch
  };
  const memory = {
    vaultPath: ".",
    repositoryBranch: config.memoryBranch,
    mcpServerName: config.mcpName,
    syncMode: config.syncMode,
    layout: {
      profile: "canonical-v1"
    }
  };

  if (config.sourceRemote) {
    source.remoteUrl = config.sourceRemote;
  }
  if (documentationPaths.length > 0) {
    source.documentationPaths = documentationPaths;
  }
  if (config.memoryRemote) {
    memory.repositoryRemote = config.memoryRemote;
  }

  return {
    schemaVersion: "1.0.0",
    project: {
      id: config.projectId,
      name: config.projectName,
      description: config.description
    },
    source,
    memory,
    agents: config.agents.map((id) => ({
      id,
      enabled: true,
      skillName: config.projectId
    })),
    security: {
      mcpAccess: "read-only",
      sensitiveDataPolicy: "forbidden",
      writeRequiresExplicitAuthorization: true,
      allowCredentialsInMemory: false
    },
    automation: {
      enabled: false,
      reviewBranch: config.integrationBranch,
      requiresMergedChange: true,
      schedule: "Not configured"
    }
  };
}

function inspectTarget(destination, generatedFile) {
  const absolutePath = path.join(destination, generatedFile.relativePath);
  const parentConflict = findParentConflict(destination, absolutePath);

  if (parentConflict) {
    return {
      ...generatedFile,
      absolutePath,
      action: "conflict",
      reason: `Un componente de la ruta no es un directorio: ${parentConflict}`
    };
  }

  if (!fs.existsSync(absolutePath)) {
    return { ...generatedFile, absolutePath, action: "create" };
  }

  const stats = fs.lstatSync(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return {
      ...generatedFile,
      absolutePath,
      action: "conflict",
      reason: "La ruta existente no es un archivo regular."
    };
  }

  const current = fs.readFileSync(absolutePath, "utf8");
  if (current === generatedFile.content) {
    return { ...generatedFile, absolutePath, action: "unchanged" };
  }

  return {
    ...generatedFile,
    absolutePath,
    action: "conflict",
    reason: "El archivo existente tiene contenido diferente."
  };
}

function createReport(config, files, apply) {
  return {
    command: "init",
    status: "preview",
    mode: apply ? "apply" : "preview",
    destination: config.destination,
    project: {
      id: config.projectId,
      name: config.projectName
    },
    summary: {
      create: files.filter((file) => file.action === "create").length,
      unchanged: files.filter((file) => file.action === "unchanged").length,
      conflicts: files.filter((file) => file.action === "conflict").length
    },
    files: files.map(({ relativePath, action, reason }) => ({
      path: relativePath,
      action,
      ...(reason ? { reason } : {})
    }))
  };
}

function collectFiles(rootDirectory) {
  const files = [];
  const pending = [rootDirectory];

  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files.sort();
}

function renderTemplate(content, replacements) {
  let rendered = content;
  for (const [name, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(`{{${name}}}`, value);
  }
  return rendered;
}

function findParentConflict(destination, targetPath) {
  let current = path.dirname(targetPath);
  const root = path.resolve(destination);

  while (current.startsWith(root) && current !== path.dirname(current)) {
    if (fs.existsSync(current) && !isDirectory(current)) {
      return current;
    }
    if (current === root) {
      break;
    }
    current = path.dirname(current);
  }

  return null;
}

function resolvePhysicalPath(candidate) {
  let current = path.resolve(candidate);
  const missingSegments = [];

  while (!fs.existsSync(current) && current !== path.dirname(current)) {
    missingSegments.unshift(path.basename(current));
    current = path.dirname(current);
  }

  const physicalParent = fs.existsSync(current)
    ? fs.realpathSync(current)
    : current;
  return path.join(physicalParent, ...missingSegments);
}

function isSameOrInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasEmbeddedCredentials(value) {
  try {
    const url = new URL(value);
    const sensitiveQueryKeys = [
      "access_token",
      "api_key",
      "apikey",
      "auth",
      "password",
      "secret",
      "token"
    ];
    return (
      Boolean(url.username || url.password) ||
      sensitiveQueryKeys.some((key) => url.searchParams.has(key))
    );
  } catch {
    return /(?:access_token|api_key|password|secret|token)=/i.test(value);
  }
}

function isGitRepository(directory) {
  try {
    execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

function isDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function normalizeRelativePath(value) {
  return value.split(path.sep).join("/");
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export class InitializationError extends Error {
  constructor(details) {
    super(details.join(" "));
    this.name = "InitializationError";
    this.details = details;
  }
}
