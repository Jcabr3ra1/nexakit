import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { diagnoseMemory } from "./doctor.js";
import { parseGitHubRepository, readManifest, readReviewedPullRequests, validateAutomation } from "./sync.js";
import { containsSensitiveData, isCredentialPath } from "./sensitive-data.js";

export const INSPECT_LIMITS = Object.freeze({
  callMs: 30_000, totalMs: 90_000, responseBytes: 5 * 1024 * 1024,
  outputBytes: 1024 * 1024, filePages: 10, checkPages: 10, checks: 500, notes: 20
});
const SHA = /^[a-f0-9]{40}$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const ADVERSE = new Set(["failure", "error", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);
const CANONICAL_DIRS = ["01-PRODUCTO", "02-ARQUITECTURA", "03-IMPLEMENTACION", "04-DECISIONES", "05-ENTREGAS", "06-OPERACION"];

export class SyncInspectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SyncInspectionError";
    this.code = code;
    this.details = [message];
  }
}

export function inspectionErrorReport(error) {
  const safe = error instanceof SyncInspectionError ? error : new SyncInspectionError("inspection-error", "No se pudo completar la inspección de forma segura.");
  return { command: "sync inspect", status: "error", code: safe.code, details: safe.details };
}

export async function inspectMemorySync(options = {}, context = {}) {
  const prNumber = positiveInteger(options.pr, Number.MAX_SAFE_INTEGER, "--pr");
  const maxFiles = positiveInteger(options.maxFiles ?? 200, 1000, "--max-files");
  const clock = context.clock ?? Date.now;
  const started = clock();
  const warnings = [];
  const warn = (code, message) => {
    if (!warnings.some((item) => item.code === code && item.message === message)) warnings.push({ code, message });
  };
  const doctor = await (context.diagnoseMemory ?? diagnoseMemory)(path.resolve(options.targetPath ?? process.cwd()), {
    manifestPath: options.manifestPath ? path.resolve(options.manifestPath) : undefined,
    schemaPath: context.schemaPath
  }).catch(() => { throw new SyncInspectionError("doctor-error", "No se pudo diagnosticar la memoria."); });
  if (doctor.status === "error" || !doctor.manifestPath || !doctor.vaultPath) {
    throw new SyncInspectionError("doctor-error", "La memoria no superó project-memory doctor.");
  }
  if (doctor.status === "warning" || doctor.checks?.some((item) => item.level === "warning")) {
    warn("doctor-warning", "Doctor informó advertencias; revisa el diagnóstico antes de cerrar el trabajo.");
  }
  let manifest, repository, reviewed;
  const ledgerPath = path.join(doctor.vaultPath, "00-INICIO/Registro de sincronización.md");
  try {
    manifest = readManifest(doctor.manifestPath);
    validateAutomation(manifest);
    repository = parseGitHubRepository(manifest.source?.remoteUrl);
    reviewed = readReviewedPullRequests(ledgerPath, repository);
  } catch {
    throw new SyncInspectionError("configuration-error", "Comprueba el manifiesto, la automatización y la tabla del registro.");
  }
  const branch = manifest.automation.reviewBranch;
  if ([repository, branch, ledgerPath].some((value) => typeof value !== "string" || CONTROL.test(value) || containsSensitiveData(value))) {
    throw new SyncInspectionError("configuration-error", "La configuración contiene valores que no pueden emitirse de forma segura.");
  }
  const query = createQuery(context.runCommand ?? runExternalCommand, clock, started);
  const raw = await query(["pr", "view", String(prNumber), "--repo", `github.com/${repository}`, "--json", "number,url,title,body,state,baseRefName,headRefOid,mergedAt,mergeCommit,changedFiles"]);
  validatePullRequest(raw, prNumber, repository, branch);
  const safeText = (value, limit, field) => {
    if (value === null || value === undefined) return null;
    if (containsSensitiveData(value)) {
      warn("sensitive-field", `Se omitió un campo sensible: ${field}.`);
      return null;
    }
    // Keep line breaks in descriptions, remove terminal control characters.
    const clean = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
    if (clean !== value) warn("text-controls", "Se retiraron caracteres de control de texto externo.");
    if (clean.length > limit) warn("text-limit", `Texto limitado: ${field}.`);
    return clean.slice(0, limit);
  };
  const safeUrl = (value) => {
    if (value === null || value === undefined) return null;
    const result = repositoryUrl(value, repository);
    if (!result) warn("unsafe-reference", "Se omitió una referencia externa o insegura.");
    return result;
  };
  const pullRequest = {
    number: prNumber, url: raw.url, title: safeText(raw.title, 300, "title"),
    description: safeText(raw.body, 4000, "description"), baseBranch: branch,
    mergedAt: new Date(raw.mergedAt).toISOString(), headCommit: raw.headRefOid, mergeCommit: raw.mergeCommit.oid
  };
  const inventory = await collectFiles(query, repository, prNumber, maxFiles, raw.changedFiles, warn);
  const checks = await collectChecks(query, repository, raw.headRefOid, safeText, safeUrl, warn);
  const { candidateAreas, unmappedFiles } = resolveCandidateAreas(doctor.vaultPath, manifest.memory?.layout, inventory.files, warn, manifest.automation?.areas);
  const report = {
    command: "sync inspect", status: checks.summary.adverse > 0 ? "blocked" : warnings.length ? "partial" : "ready",
    repository, branch, ledgerPath, alreadyReviewed: reviewed.has(prNumber), pullRequest,
    files: inventory.files, checks, candidateAreas, unmappedFiles,
    coverage: { files: inventory.coverage, checks: { complete: checks.complete, pages: checks.pages, received: checks.received }, candidateNotesLimit: INSPECT_LIMITS.notes },
    warnings, observedAt: new Date(clock()).toISOString()
  };
  if (Buffer.byteLength(JSON.stringify(report, null, 2)) > INSPECT_LIMITS.outputBytes) {
    throw new SyncInspectionError("output-limit", "El informe supera el límite seguro de salida; reduce --max-files.");
  }
  return report;
}

function positiveInteger(value, max, label) {
  if (!(typeof value === "number" || typeof value === "string" && /^\d+$/.test(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) {
    throw new SyncInspectionError("invalid-option", `${label} requiere un entero positivo dentro del rango permitido.`);
  }
  return Number(value);
}

function createQuery(runCommand, clock, started) {
  return async (args) => {
    const remaining = INSPECT_LIMITS.totalMs - (clock() - started);
    if (remaining <= 0) throw new SyncInspectionError("timeout", "Se agotó el tiempo de inspección.");
    let output;
    try {
      output = await runCommand("gh", args, { timeout: Math.min(INSPECT_LIMITS.callMs, remaining), maxBuffer: INSPECT_LIMITS.responseBytes });
    } catch (error) {
      throw externalQueryError(error);
    }
    if (clock() - started > INSPECT_LIMITS.totalMs) throw new SyncInspectionError("timeout", "Se agotó el tiempo de inspección.");
    if (typeof output !== "string" || Buffer.byteLength(output) > INSPECT_LIMITS.responseBytes) {
      throw new SyncInspectionError("response-limit", "La respuesta supera el límite permitido o no es texto JSON.");
    }
    try { return JSON.parse(output); } catch { throw new SyncInspectionError("invalid-response", "GitHub CLI no devolvió JSON válido."); }
  };
}

function runExternalCommand(command, args, limits) {
  return execFileSync(command, args, { ...limits, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function externalQueryError(error) {
  // Classify errors in memory without ever returning their original streams.
  const diagnostic = String(error?.stderr ?? "");
  let code = "github-unavailable";
  if (error?.code === "ENOENT") code = "command-missing";
  else if (error?.code === "ENOBUFS") code = "response-limit";
  else if (error?.code === "ETIMEDOUT" || error?.signal) code = "timeout";
  else if (/HTTP 429|rate limit/i.test(diagnostic)) code = "github-rate-limit";
  else if (/HTTP 401|gh auth login/i.test(diagnostic)) code = "github-authentication";
  else if (/HTTP 403/i.test(diagnostic)) code = "github-permissions";
  const messages = {
    "command-missing": "GitHub CLI no está disponible.",
    "response-limit": "La respuesta supera el límite permitido.",
    timeout: "La consulta agotó el tiempo permitido.",
    "github-rate-limit": "GitHub alcanzó su límite de consultas; vuelve a intentarlo más tarde.",
    "github-authentication": "Comprueba la autenticación existente de GitHub CLI.",
    "github-permissions": "La cuenta no tiene permisos suficientes para esta consulta.",
    "github-unavailable": "GitHub no está disponible; comprueba autenticación, permisos y límites de API."
  };
  return new SyncInspectionError(code, messages[code]);
}

function repositoryUrl(value, repository) {
  if (typeof value !== "string" || value.length > 2048 || CONTROL.test(value) || containsSensitiveData(value)) return null;
  try {
    const url = new URL(value);
    const prefix = `/${repository}/`.toLowerCase();
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash || !url.pathname.toLowerCase().startsWith(prefix)) return null;
    return url.href;
  } catch { return null; }
}

function validatePullRequest(raw, number, repository, branch) {
  const validUrl = repositoryUrl(raw?.url, repository);
  if (!raw || raw.number !== number || !validUrl || new URL(validUrl).pathname.toLowerCase() !== `/${repository}/pull/${number}`.toLowerCase()
    || raw.state !== "MERGED" || raw.baseRefName !== branch || typeof raw.mergedAt !== "string" || Number.isNaN(Date.parse(raw.mergedAt))
    || typeof raw.headRefOid !== "string" || !SHA.test(raw.headRefOid)
    || typeof raw.mergeCommit?.oid !== "string" || !SHA.test(raw.mergeCommit.oid)
    || typeof raw.title !== "string" || !(raw.body === null || typeof raw.body === "string")
    || !Number.isSafeInteger(raw.changedFiles) || raw.changedFiles < 0) {
    throw new SyncInspectionError("invalid-pull-request", "El PR no es un cambio fusionado válido del repositorio y rama configurados.");
  }
}

function validRelativePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && !CONTROL.test(value) && !value.startsWith("/") && !/^[a-z]:/i.test(value)
    && !value.includes("\\") && !value.split("/").some((part) => ["", ".", ".."].includes(part));
}

async function collectFiles(query, repository, number, limit, expected, warn) {
  const files = new Map();
  const seen = new Set();
  let pages = 0, received = 0, omitted = 0, complete = expected === 0;
  const statuses = new Set(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]);
  try {
    while (!complete && pages < INSPECT_LIMITS.filePages && received < limit) {
      // Keep page size constant: changing it changes GitHub's page offsets.
      const perPage = Math.min(100, limit);
      const values = await query(["api", "--hostname", "github.com", "--method", "GET", `repos/${repository}/pulls/${number}/files?per_page=${perPage}&page=${pages + 1}`, "--jq", "map({filename,previous_filename,status,additions,deletions})"]);
      pages++;
      if (!Array.isArray(values) || values.length > perPage) throw new SyncInspectionError("invalid-files", "Inventario de archivos inválido.");
      const selected = values.slice(0, limit - received);
      received += selected.length;
      for (const value of selected) {
        if (!validRelativePath(value?.filename) || (value.previous_filename != null && !validRelativePath(value.previous_filename))
          || !statuses.has(value.status) || !Number.isSafeInteger(value.additions) || value.additions < 0 || !Number.isSafeInteger(value.deletions) || value.deletions < 0
          || value.status === "renamed" && !value.previous_filename) {
          throw new SyncInspectionError("invalid-files", "El inventario contiene entradas inválidas.");
        }
        if (seen.has(value.filename)) warn("duplicate-files", "GitHub devolvió archivos repetidos; el inventario se deduplicó.");
        seen.add(value.filename);
        if ([value.filename, value.previous_filename].filter(Boolean).some((name) => containsSensitiveData(name) || isCredentialPath(name))) {
          omitted++;
          warn("sensitive-files", "Se omitieron rutas sensibles del inventario y de las candidatas.");
          continue;
        }
        files.set(value.filename, { path: value.filename, previousPath: value.previous_filename ?? null, change: value.status, additions: value.additions, deletions: value.deletions });
      }
      // A short last page cannot prove completeness unless the expected count
      // agrees. Bounded selection may intentionally omit part of a full page.
      complete = seen.size === expected && received === expected && values.length === selected.length;
      if (values.length < perPage || received >= expected) break;
    }
  } catch (error) {
    if (!(error instanceof SyncInspectionError)) throw error;
    warn(`files-${error.code}`, "El inventario no pudo completarse; requiere revisión manual.");
    complete = false;
  }
  if (!complete) warn("files-incomplete", "El inventario está limitado o no coincide con el total del PR.");
  return {
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en")),
    coverage: { expected, received, unique: seen.size, visible: files.size, omitted, pages, limit, complete }
  };
}

async function collectChecks(query, repository, commit, safeText, safeUrl, warn) {
  const results = new Map();
  let pages = 0, received = 0, complete = true;
  async function collect(kind) {
    let page = 1, count = 0;
    while (pages < INSPECT_LIMITS.checkPages && received < INSPECT_LIMITS.checks) {
      const perPage = 100;
      const endpoint = kind === "check-run" ? `check-runs?filter=latest&per_page=${perPage}&page=${page}` : `status?per_page=${perPage}&page=${page}`;
      const jq = kind === "check-run" ? "{total_count,check_runs:[.check_runs[]|{id,name,status,conclusion,head_sha,html_url,completed_at,started_at,app:{id:.app.id}}]}" : "{sha,total_count,state,statuses:[.statuses[]|{context,state,target_url,updated_at}]}";
      const response = await query(["api", "--hostname", "github.com", "--method", "GET", `repos/${repository}/commits/${commit}/${endpoint}`, "--jq", jq]);
      pages++;
      const values = kind === "check-run" ? response?.check_runs : response?.statuses;
      if (!Number.isSafeInteger(response?.total_count) || response.total_count < 0 || !Array.isArray(values) || values.length > perPage || kind === "commit-status" && (response.sha !== commit || !["pending", "success", "failure", "error"].includes(response.state))) {
        throw new SyncInspectionError("invalid-checks", "La respuesta de comprobaciones no es válida para el commit consultado.");
      }
      // Combined state remains useful when individual contexts are truncated.
      if (kind === "commit-status" && ["failure", "error"].includes(response.state)) {
        results.set("combined-status", { kind: "commit-status-summary", name: "Estado combinado de GitHub", state: response.state, conclusion: response.state, url: null, commit, timestamp: null });
      }
      const selected = values.slice(0, INSPECT_LIMITS.checks - received);
      count += selected.length;
      received += selected.length;
      for (const value of selected) {
        const rawName = kind === "check-run" ? value?.name : value?.context;
        const validRun = kind !== "check-run" || (typeof value?.status === "string" && value.head_sha === commit && Number.isSafeInteger(value.id) && value.id > 0 && Number.isSafeInteger(value.app?.id) && value.app.id > 0);
        const validStatus = kind !== "commit-status" || ["success", "failure", "error", "pending"].includes(value?.state);
        if (typeof rawName !== "string" || !validRun || !validStatus) {
          throw new SyncInspectionError("invalid-checks", "Una comprobación no pertenece al commit o contiene datos inválidos.");
        }
        let state = kind === "check-run" ? value.status : value.state;
        let conclusion = kind === "check-run" ? value.conclusion : value.state;
        if (conclusion !== null && typeof conclusion !== "string") throw new SyncInspectionError("invalid-checks", "La conclusión de una comprobación no es válida.");
        if (!["queued", "in_progress", "waiting", "requested", "pending", "completed", "success", "failure", "error"].includes(state)) {
          state = "unknown";
          warn("checks-unknown-state", "Se recibió un estado de comprobación desconocido.");
        }
        if (conclusion !== null && !["success", "failure", "error", "pending", "neutral", "skipped", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(conclusion)) {
          conclusion = "unknown";
          warn("checks-unknown-conclusion", "Se recibió una conclusión de comprobación desconocida.");
        }
        const name = safeText(rawName, 200, "check.name");
        const url = safeUrl(kind === "check-run" ? value.html_url : value.target_url);
        const rawDate = kind === "check-run" ? value.completed_at ?? value.started_at : value.updated_at;
        const timestamp = typeof rawDate === "string" && !Number.isNaN(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null;
        if (timestamp === null) warn("checks-date-missing", "Una comprobación no tiene fecha válida disponible.");
        const key = `${kind}:${kind === "check-run" ? value.app.id : "context"}:${rawName}`;
        const next = { kind, name, state, conclusion, url, commit, timestamp };
        const prev = results.get(key);
        if (!prev || Date.parse(timestamp ?? "") >= Date.parse(prev.timestamp ?? "") || !prev.timestamp) results.set(key, next);
      }
      if (count === response.total_count) return;
      if (values.length < perPage || count > response.total_count) break;
      page++;
    }
    throw new SyncInspectionError("checks-limit", "No se pudieron recuperar todas las comprobaciones.");
  }
  for (const kind of ["check-run", "commit-status"]) {
    try { await collect(kind); }
    catch (error) {
      if (!(error instanceof SyncInspectionError)) throw error;
      complete = false;
      warn(`checks-${error.code}`, "Una sección de comprobaciones está incompleta o no disponible.");
    }
  }
  const items = [...results.values()].sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`, "en"));
  const summary = { success: 0, adverse: 0, pending: 0, other: 0 };
  for (const item of items) {
    if (ADVERSE.has(item.state) || ADVERSE.has(item.conclusion)) summary.adverse++;
    else if (item.conclusion === "success" && (item.state === "completed" || item.state === "success")) summary.success++;
    else if (item.state === "pending" || ["queued", "in_progress", "waiting", "requested"].includes(item.state)) summary.pending++;
    else summary.other++;
  }
  if (!items.length) warn("checks-missing", "No hay evidencia disponible de CI para el SHA de cabecera del PR.");
  if (summary.pending || summary.other) warn("checks-not-success", "Hay comprobaciones pendientes, omitidas, neutrales o desconocidas.");
  return { subject: "pr-head", commit, historical: false, complete, pages, received, items, summary };
}

const RULES = [
  { id: "backend-path", category: "backend", test: /(?:^|\/)[^/]*(?:backend|server|api)[^/]*(?:\/|$)/i, destinations: /(?:BACKEND|ARQUITECTURA|IMPLEMENTACION)$/ },
  { id: "frontend-path", category: "frontend", test: /(?:^|\/)[^/]*(?:frontend|client|web|ui)[^/]*(?:\/|$)/i, destinations: /(?:FRONTEND|IMPLEMENTACION)$/ },
  { id: "firmware-path", category: "hardware", test: /(?:^|\/)[^/]*(?:firmware|hardware|iot|esp32)[^/]*(?:\/|$)|\.(?:ino)$/i, destinations: /(?:IOT|HARDWARE|IMPLEMENTACION)$/ },
  { id: "docs-path", category: "documentation", test: /(?:^|\/)(?:docs|documentation)(?:\/|$)|\.(?:md|mdx)$/i, destinations: /(?:PRODUCTO|ARQUITECTURA|IMPLEMENTACION)$/ },
  { id: "operations-path", category: "operations", test: /(?:^|\/)(?:\.github|\.claude-plugin|infra|deploy|docker|scripts)(?:\/|$)|(?:^|\/)(?:Dockerfile|docker-compose[^/]*|\.gitignore|\.gitattributes|package(?:-lock)?\.json)$/i, destinations: /(?:OPERACION)$/ },
  { id: "tests-path", category: "tests", test: /(?:^|\/)(?:test|tests|__tests__|test-support|testing)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i, destinations: /(?:IMPLEMENTACION|ENTREGAS|SPRINTS)$/ },
  { id: "decisions-path", category: "decisions", test: /(?:^|\/)(?:adr|decisions|decisiones)(?:\/|$)/i, destinations: /(?:DECISIONES)$/ },
  // Solo carpetas de código en la raíz: así no se solapa con las reglas por nombre de carpeta (frontend/src/...).
  { id: "source-path", category: "implementation", test: /^(?:src|lib|app|bin|packages|plugins|schemas|templates|examples)\//i, destinations: /(?:IMPLEMENTACION)$/ }
];

// automation.areas permite al proyecto elegir la carpeta de una categoría que tiene varias candidatas.
const declaredAreas = (areas) => (areas && typeof areas === "object" && !Array.isArray(areas) ? areas : {});

function resolveCandidateAreas(vault, layout, files, warn, areas) {
  const declared = declaredAreas(areas);
  const dirs = layout?.profile === "declared" ? layout.requiredDirectories : CANONICAL_DIRS;
  const allowed = [];
  for (const dir of dirs ?? []) {
    if (!validRelativePath(dir) || dir.includes("/") || containsSensitiveData(dir) || isCredentialPath(dir)) continue;
    try {
      const stat = fs.lstatSync(path.join(vault, dir));
      if (stat.isDirectory() && !stat.isSymbolicLink()) allowed.push(dir);
    } catch { /* Doctor supplies structural diagnostics. */ }
  }
  const candidateAreas = [];
  const unmappedFiles = [];
  for (const file of files) {
    if (!RULES.some((rule) => [file.path, file.previousPath].filter(Boolean).some((name) => rule.test.test(name)))) unmappedFiles.push(file.path);
  }
  if (unmappedFiles.length) warn("unmapped-files", "Hay archivos sin clasificación; requieren revisión manual.");
  for (const rule of RULES) {
    const matchingFiles = files.filter((file) => [file.path, file.previousPath].filter(Boolean).some((name) => rule.test.test(name))).map((file) => file.path);
    if (!matchingFiles.length) continue;
    const destinations = allowed.filter((dir) => rule.destinations.test(dir.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase()));
    // Prefer a precise area (e.g. BACKEND), otherwise a single generic match.
    const exact = destinations.filter((dir) => dir.toLowerCase().endsWith(rule.category) || rule.category === "hardware" && /(?:iot|hardware)$/i.test(dir));
    const choices = exact.length ? exact : destinations;
    const chosen = declared[rule.category];
    const usesDeclared = typeof chosen === "string" && allowed.includes(chosen);
    if (chosen !== undefined && !usesDeclared) warn("area-override-invalid", `El mapeo declarado para ${rule.category} no apunta a una carpeta permitida de la bóveda.`);
    const directory = usesDeclared ? chosen : choices.length === 1 ? choices[0] : null;
    const notes = [];
    let omittedNotes = 0;
    if (directory === null) warn("area-unresolved", "Una categoría no tiene carpeta inequívoca; requiere revisión manual.");
    else {
      try {
        // Direct entries only: never traverse nested Skills/resources or symlinks.
        const entries = fs.readdirSync(path.join(vault, directory), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name, "en"));
        for (const entry of entries) {
          const note = `${directory}/${entry.name}`;
          if (!validRelativePath(note) || containsSensitiveData(note) || isCredentialPath(note)) { omittedNotes++; continue; }
          if (notes.length < INSPECT_LIMITS.notes) notes.push(note); else omittedNotes++;
        }
        if (omittedNotes) warn("notes-omitted", "Se omitieron rutas de notas por seguridad o límite de candidatas.");
      } catch { warn("notes-unavailable", "No se pudieron enumerar las notas de un área candidata."); }
    }
    candidateAreas.push({ category: rule.category, directory, notes, rule: rule.id, files: matchingFiles, omittedNotes });
  }
  if (!candidateAreas.length) warn("no-candidates", "No hay áreas candidatas; requiere revisión manual, no equivale a ausencia de cambios documentales.");
  return { candidateAreas, unmappedFiles };
}

export function formatSyncInspectionReport(report) {
  const lines = [
    `Project Memory Sync Inspect: ${report.status.toUpperCase()}`,
    `Repositorio: ${report.repository}; rama: ${report.branch}`,
    `PR #${report.pullRequest.number}: ${report.pullRequest.title ?? "[omitido]"}`,
    report.pullRequest.url,
    `Integración: ${report.pullRequest.mergeCommit}; fecha: ${report.pullRequest.mergedAt}`,
    `Ya revisado: ${report.alreadyReviewed ? "sí" : "no"}; registro: ${report.ledgerPath}`,
    `Consulta: ${report.observedAt}`,
    "Descripción atribuida al PR (no verificación):", report.pullRequest.description ?? "[sin descripción visible]",
    `Archivos: ${report.coverage.files.visible} visibles / ${report.coverage.files.expected} esperados; ${report.coverage.files.omitted} omitidos; cobertura ${report.coverage.files.complete ? "completa" : "incompleta"}`,
    `Inventario: ${report.coverage.files.received} recibidos, ${report.coverage.files.unique} únicos, ${report.coverage.files.pages} páginas`
  ];
  for (const file of report.files) lines.push(`- ${file.change}: ${file.path}${file.previousPath ? ` (antes: ${file.previousPath})` : ""}; +${file.additions} -${file.deletions}`);
  lines.push(`CI del SHA de cabecera ${report.checks.commit} (no prueba de integración ni ejecución local):`);
  for (const item of report.checks.items) lines.push(`- ${item.kind}: ${item.name ?? "[omitido]"}; ${item.state}/${item.conclusion ?? "sin conclusión"}; ${item.url ?? "sin referencia"}${item.timestamp ? `; ${item.timestamp}` : ""}`);
  lines.push(`CI: ${report.checks.summary.success} éxitos, ${report.checks.summary.adverse} adversos, ${report.checks.summary.pending} pendientes, ${report.checks.summary.other} otros; cobertura ${report.checks.complete ? "completa" : "incompleta"}`);
  lines.push("Áreas candidatas (no autorización para editar):");
  for (const area of report.candidateAreas) {
    lines.push(`- ${area.category}: ${area.directory ?? "sin carpeta inequívoca"}; regla ${area.rule}; ${area.omittedNotes} notas omitidas`);
    for (const file of area.files) lines.push(`    motivo: ${file}`);
    for (const note of area.notes) lines.push(`    candidata: ${note}`);
  }
  for (const file of report.unmappedFiles) lines.push(`Sin clasificación: ${file}`);
  lines.push(`Límites: ${report.coverage.files.limit} archivos; ${report.coverage.candidateNotesLimit} notas por área; ${report.checks.received} checks recibidos en ${report.checks.pages} páginas`);
  for (const warning of report.warnings) lines.push(`! [${warning.code}] ${warning.message}`);
  lines.push("Inspección de solo lectura. ready no significa aprobación del código ni de la memoria.");
  const text = lines.join("\n");
  if (Buffer.byteLength(text) > INSPECT_LIMITS.outputBytes) throw new SyncInspectionError("output-limit", "El informe supera el límite seguro de salida.");
  return text;
}
