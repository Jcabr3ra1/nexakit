import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { diagnoseMemory } from "./doctor.js";
import { inspectMemorySync } from "./sync-inspect.js";
import { parseGitHubRepository, validateAutomation } from "./sync.js";
import { parseWritableLedger } from "./sync-ledger.js";
import { containsSensitiveData } from "./sensitive-data.js";
import { APPLY_LIMITS, parseProposal, proposalPlanId } from "./sync-proposal.js";
import { collectMemoryNotes, noteUnifiedDiff, validateNoteText, validateVirtualMemory } from "./sync-markdown.js";
import { SyncFileError, SYNC_LEDGER, assertOwnedArtifact, assertSameState, decodeUtf8, hashBytes,
  memoryPath, normalizeSyncText, physicalFile, readSyncFile, rejectFile, relativeGitPath, requireRegularGitFile, requireVisibleGitFiles, sameSyncText,
  syncGit, syncGitState, syncWriteLockPath } from "./sync-files.js";

const ACK_CODES = new Set(["text-limit", "unsafe-reference"]);
const AREAS = ["00-INICIO", "01-PRODUCTO", "02-ARQUITECTURA", "03-IMPLEMENTACION", "04-DECISIONES",
  "05-ENTREGAS", "06-OPERACION", "07-AGENTES", "08-RECURSOS", "09-ARCHIVO"];
export const APPLY_CONCURRENCY_NOTICE = "Pausa edición y sincronización durante --apply: el bloqueo no controla editores externos.";

export function applyErrorReport(error) {
  const safe = error instanceof SyncFileError ? error : new SyncFileError("apply-error", "No se pudo completar la aplicación de forma segura.", "error");
  return { command: "sync apply", status: safe.status, code: safe.code, details: [safe.message],
    wrote: false, applied: [], satisfied: [], pending: [], uncertain: [], concurrencyNotice: APPLY_CONCURRENCY_NOTICE };
}
export async function applyMemorySync(options = {}, context = {}) {
  validateOptions(options);
  try { return await prepareApply({ ...options, ackWarnings: [...new Set(options.ackWarnings ?? [])].sort() }, context); }
  catch (error) { if (error instanceof SyncFileError) throw error; rejectFile("apply-error", "No se pudo completar la aplicación; revisa permisos, configuración y estado.", "error"); }
}
function validateOptions(options) {
  const keys = new Set(["targetPath", "manifestPath", "proposalPath", "ackWarnings", "reviewed", "apply", "expect"]);
  const invalid = () => rejectFile("invalid-option", "Indica una propuesta válida; aplicar exige --reviewed y --expect; no se admiten opciones contradictorias.", "error");
  if (Object.keys(options).some((key) => !keys.has(key)) || !options.proposalPath) invalid();
  for (const key of ["targetPath", "manifestPath", "proposalPath"]) if (options[key] !== undefined && (typeof options[key] !== "string"
    || !options[key] || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(options[key]) || containsSensitiveData(options[key]))) invalid();
  for (const key of ["apply", "reviewed"]) if (options[key] !== undefined && typeof options[key] !== "boolean") invalid();
  if (options.apply ? options.reviewed !== true || typeof options.expect !== "string" || !/^[a-f0-9]{64}$/.test(options.expect) : options.expect !== undefined) invalid();
  if (!Array.isArray(options.ackWarnings ?? []) || (options.ackWarnings?.length ?? 0) > 2
    || (options.ackWarnings ?? []).some((code) => !ACK_CODES.has(code))) invalid();
}
async function prepareApply(input, context) {
  const target = path.resolve(input.targetPath ?? process.cwd());
  const candidate = input.manifestPath ? path.resolve(input.manifestPath) : fs.lstatSync(target).isFile() ? target
    : ["project-memory.json", "project-memory.local.json", "project-memory.example.json"].map((n) => path.join(target, n)).find((p) => fs.existsSync(p));
  if (!candidate) rejectFile("manifest-missing", "No se encontró un manifiesto de memoria.", "blocked");
  const manifestFile = readSyncFile(physicalFile(candidate), APPLY_LIMITS.manifest);
  const proposalFile = readSyncFile(physicalFile(path.resolve(input.proposalPath)), APPLY_LIMITS.proposal);
  const proposal = parseProposal(proposalFile.text);
  const doctor = await (context.diagnoseMemory ?? diagnoseMemory)(target, { manifestPath: manifestFile.path, schemaPath: context.schemaPath });
  if (!["ok", "warning"].includes(doctor.status) || !doctor.vaultPath || !doctor.manifestPath
    || doctor.checks?.some((c) => c.level === "error")) rejectFile("doctor-error", "La memoria no superó project-memory doctor.", "blocked");
  const vault = physicalFile(doctor.vaultPath);
  if (!fs.statSync(vault).isDirectory() || containsSensitiveData(vault) || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(vault)) rejectFile("unsafe-path", "La raíz de memoria es incompatible.");
  if (proposalFile.path === vault || proposalFile.path.startsWith(vault + path.sep)) rejectFile("proposal-location", "La propuesta debe estar fuera de la bóveda.", "blocked");
  if (physicalFile(doctor.manifestPath) !== manifestFile.path) rejectFile("manifest-change", "El diagnóstico seleccionó otro manifiesto.");
  assertSameState(fileState(manifestFile), fileState(readSyncFile(manifestFile.path, APPLY_LIMITS.manifest)));
  const manifest = JSON.parse(manifestFile.text);
  validateAutomation(manifest);
  if (containsSensitiveData(manifestFile.text) || manifest.security?.writeRequiresExplicitAuthorization !== true
    || manifest.security?.allowCredentialsInMemory !== false || manifest.security?.sensitiveDataPolicy !== "forbidden") rejectFile("unsafe-config", "El manifiesto no cumple la política de escritura controlada.", "blocked");
  const repository = parseGitHubRepository(manifest.source?.remoteUrl);
  if (proposal.projectId !== manifest.project?.id || proposal.repository !== repository
    || proposal.reviewBranch !== manifest.automation.reviewBranch || proposal.manifestSha256 !== manifestFile.hash) rejectFile("proposal-identity", "La identidad o el manifiesto no coinciden con la propuesta.");
  const ledgerFile = readSyncFile(memoryPath(vault, SYNC_LEDGER), APPLY_LIMITS.ledger);
  let ledger;
  try { ledger = parseWritableLedger(ledgerFile.text, repository); }
  catch { rejectFile("invalid-ledger", "El registro es ambiguo o incompatible."); }
  if (ledger.records.get(proposal.pr)?.state === "Revisado") rejectFile("already-reviewed", "El PR ya está registrado como revisado.", "blocked");
  const git = syncGitState(vault); requireVisibleGitFiles(vault); requireRegularGitFile(vault, SYNC_LEDGER);
  if (git.head !== proposal.memoryHead || git.branch !== manifest.memory?.repositoryBranch) rejectFile("memory-version", "HEAD o la rama de memoria no coinciden con la propuesta.");
  const ledgerHead = syncGit(vault, ["show", `HEAD:${SYNC_LEDGER}`]), ledgerIndex = syncGit(vault, ["show", `:${SYNC_LEDGER}`]);
  if (!sameSyncText(decodeUtf8(ledgerHead), ledgerFile.text) || !ledgerHead.equals(ledgerIndex)) rejectFile("dirty-ledger", "El registro debe estar limpio en HEAD, staging y disco.");
  const catalog = collectMemoryNotes(vault), areas = manifest.memory?.layout?.profile === "declared" ? manifest.memory.layout.requiredDirectories : AREAS;
  let originalBytes = 0;
  const notes = proposal.notes.map((note) => {
    if (!(areas ?? []).some((area) => note.path.startsWith(area + "/"))) rejectFile("note-area", "Una nota queda fuera de las áreas declaradas.");
    const file = catalog.get(note.path);
    if (!file) rejectFile("note-missing", "Una nota propuesta no existe con esa ruta exacta.");
    requireRegularGitFile(vault, note.path);
    const head = syncGit(vault, ["show", `HEAD:${note.path}`]), index = syncGit(vault, ["show", `:${note.path}`]);
    originalBytes += head.length;
    if (head.length > APPLY_LIMITS.note || originalBytes > APPLY_LIMITS.totalNotes) rejectFile("notes-limit", "Las versiones originales superan el límite.", "blocked");
    if (hashBytes(head) !== note.beforeSha256 || !head.equals(index)) rejectFile("note-version", "La versión original o staging de una nota no coinciden.");
    const headText = decodeUtf8(head), bytes = Buffer.from(note.content), afterHash = hashBytes(bytes);
    validateNoteText(headText); validateNoteText(file.text);
    // Keep the existing worktree's line endings even when Git stores LF.
    const original = file.text.includes("\r\n") ? normalizeSyncText(headText).replaceAll("\n", "\r\n") : normalizeSyncText(headText);
    validateNoteText(note.content, original);
    if (sameSyncText(headText, note.content)) rejectFile("no-note-change", "Una nota propuesta no introduce ningún cambio.", "blocked");
    if (!sameSyncText(file.text, headText) && file.hash !== afterHash) rejectFile("note-conflict", "Una nota contiene cambios diferentes de la propuesta.");
    return { ...note, file, original, bytes, afterHash, satisfied: file.hash === afterHash };
  });
  if (git.changes.some((change) => change.state !== " M" || !notes.some((n) => n.path === change.path && n.satisfied))) rejectFile("foreign-changes", "Hay staging o cambios locales ajenos a las notas satisfechas.");
  const remaining = (doctor.checks ?? []).filter((check) => !(check.id === "git-cleanliness" && check.level === "warning" && git.changes.length));
  if (remaining.some((c) => c.level === "warning") || doctor.status === "warning" && !doctor.checks?.some((c) => c.level === "warning")) rejectFile("doctor-warning", "Hay advertencias de diagnóstico ajenas a las notas autorizadas.", "blocked");
  const attachments = validateVirtualMemory(vault, catalog, new Map(notes.map((n) => [n.path, n.content]))) ?? [];
  const resources = [manifestFile, proposalFile, ledgerFile];
  const capture = (ignored = []) => captureState(vault, resources, attachments, ignored);
  const before = capture();
  assertSameState(git, before.git);
  for (const file of [...resources, ...catalog.values()]) {
    const found = before.files.find((f) => f.path === file.path);
    assertSameState(fileState(file), found);
  }
  let inspection;
  try { inspection = await inspectMemorySync({ targetPath: target, manifestPath: manifestFile.path, pr: proposal.pr, maxFiles: 1000 },
    { ...context, diagnoseMemory: async () => ({ ...doctor, status: "ok", checks: remaining }) }); }
  catch { rejectFile("inspection-error", "No se pudo confirmar el PR integrado en GitHub.", "blocked"); }
  assertSameState(before, capture());
  requireEvidence(inspection, proposal, input.ackWarnings);
  const planId = proposalPlanId({ proposal, vault, proposalHash: proposalFile.hash, indexHash: git.index.hash, ledgerHash: ledgerFile.hash, acknowledgments: input.ackWarnings });
  if (input.apply && planId !== input.expect) rejectFile("approval-mismatch", "La huella aprobada no coincide; revisa una nueva vista previa.");
  const report = { command: "sync apply", status: notes.every((n) => n.satisfied) ? "unchanged" : "preview", planId,
    projectId: proposal.projectId, vaultPath: vault, repository, branch: proposal.reviewBranch, pr: proposal.pr,
    mergeCommit: proposal.mergeCommit, memoryHead: proposal.memoryHead, manifestSha256: manifestFile.hash, proposalSha256: proposalFile.hash,
    notes: notes.map((n) => ({ path: n.path, beforeSha256: n.beforeSha256, afterSha256: n.afterHash, sourcePaths: n.sourcePaths,
      state: n.satisfied ? "satisfied" : "original", diff: noteUnifiedDiff(n.path, n.original, n.content) })),
    acknowledgedWarnings: input.ackWarnings, wrote: false, applied: [], satisfied: notes.filter((n) => n.satisfied).map((n) => n.path),
    pending: notes.filter((n) => !n.satisfied).map((n) => n.path), uncertain: [], concurrencyNotice: APPLY_CONCURRENCY_NOTICE };
  // Reserve bounded room for later failure details, lists and state transitions.
  if (Buffer.byteLength(JSON.stringify(report, null, 2)) > APPLY_LIMITS.output - 64 * 1024
    || Buffer.byteLength(formatSyncApplyReport(report)) > APPLY_LIMITS.output - 64 * 1024) rejectFile("output-limit", "El informe completo excede el límite seguro; no se mostrará un diff parcial.", "blocked");
  if (!input.apply || report.status === "unchanged") return report;
  return writeNotes({ vault, notes, before, capture, report }, context);
}

function requireEvidence(inspection, proposal, acknowledgments) {
  if (inspection.repository !== proposal.repository || inspection.branch !== proposal.reviewBranch
    || inspection.pullRequest?.number !== proposal.pr || inspection.pullRequest?.mergeCommit !== proposal.mergeCommit) rejectFile("source-identity", "La identidad del PR o su SHA de integración no coinciden.");
  if (inspection.alreadyReviewed) rejectFile("already-reviewed", "El PR ya está registrado como revisado.", "blocked");
  const summary = inspection.checks?.summary;
  if (!inspection.coverage?.files?.complete || !inspection.coverage?.checks?.complete || !inspection.checks?.complete
    || !summary?.success || summary.adverse || summary.pending || summary.other || inspection.status === "blocked") rejectFile("incomplete-evidence", "Se exige inventario y CI completos, con resultados exclusivamente exitosos.", "blocked");
  const codes = new Set((inspection.warnings ?? []).map((w) => w.code));
  if ([...codes].some((c) => !ACK_CODES.has(c) || !acknowledgments.includes(c)) || acknowledgments.some((c) => !codes.has(c))) rejectFile("inspection-warning", "Hay advertencias no admitidas o excepciones no observadas.", "blocked");
  const paths = new Set(inspection.files.map((f) => f.path));
  if (proposal.notes.some((note) => note.sourcePaths.some((p) => !paths.has(p)))) rejectFile("source-path", "Una fuente declarada no pertenece al inventario completo del PR.", "blocked");
}

const fileState = (file) => ({ path: file.path, hash: file.hash, identity: file.identity });
const nodeState = (full) => { const stat = fs.lstatSync(full); if (stat.isSymbolicLink()) rejectFile("unsafe-path", "Un componente fue enlazado."); return [stat.dev, stat.ino, stat.mode]; };
function captureState(vault, resources, attachments, ignored) {
  const catalog = collectMemoryNotes(vault), files = new Map();
  for (const file of resources) files.set(file.path, readSyncFile(file.path, file.path === resources[1].path ? APPLY_LIMITS.proposal : APPLY_LIMITS.manifest));
  for (const file of catalog.values()) files.set(file.path, file);
  const directories = new Set([vault]);
  for (const file of files.values()) if (file.path.startsWith(vault + path.sep)) {
    let dir = path.dirname(file.path);
    while (dir !== vault) { directories.add(dir); dir = path.dirname(dir); }
  }
  return { git: syncGitState(vault, ignored), files: [...files.values()].map(fileState).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    directories: [...directories].sort().map((dir) => ({ path: dir, identity: nodeState(dir) })),
    attachments: attachments.map((p) => { const stat = fs.lstatSync(memoryPath(vault, p)); return { path: p, identity: [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs] }; }) };
}

function writeNotes({ vault, notes, before, capture, report }, context) {
  const io = { ...fs, ...(context.fileOperations ?? {}) }, lockPath = syncWriteLockPath(vault);
  const artifacts = [], applied = [], uncertain = [], ignored = [], expected = structuredClone(before);
  let failure, lock;
  const check = () => { assertSameState(expected, capture(ignored)); if (lock) assertOwnedArtifact(lockPath, lock); };
  try {
    check();
    const fd = io.openSync(lockPath, "wx", 0o600);
    try { lock = fs.fstatSync(fd, { bigint: true }); } finally { fs.closeSync(fd); }
    artifacts.push({ path: lockPath, stat: lock }); ignored.push(relativeGitPath(vault, lockPath));
    check();
    const pending = notes.filter((n) => !n.satisfied), temps = new Map();
    // Prepare every complete replacement before performing the first rename.
    for (const note of pending) {
      memoryPath(vault, note.path);
      const temp = path.join(path.dirname(note.file.path), `.project-memory-sync-apply-${randomUUID()}.tmp`);
      const fd = io.openSync(temp, "wx", 0o600); let stat;
      try {
        stat = fs.fstatSync(fd, { bigint: true }); artifacts.push({ path: temp, stat }); ignored.push(relativeGitPath(vault, temp));
        io.writeFileSync(fd, note.bytes); io.fchmodSync(fd, note.file.mode); io.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      assertOwnedArtifact(temp, stat);
      const prepared = readSyncFile(temp, APPLY_LIMITS.note);
      if (prepared.hash !== note.afterHash || prepared.mode !== note.file.mode) rejectFile("temporary-content", "Un temporal no coincide con el contenido y permisos aprobados.");
      temps.set(note.path, { path: temp, stat });
    }
    for (const note of pending) {
      check();
      const temp = temps.get(note.path); assertOwnedArtifact(temp.path, temp.stat);
      const prepared = readSyncFile(temp.path, APPLY_LIMITS.note);
      if (prepared.hash !== note.afterHash || prepared.mode !== note.file.mode) rejectFile("temporary-content", "Un temporal cambió antes de reemplazar.");
      let renameError;
      try { io.renameSync(temp.path, note.file.path); } catch (error) { renameError = error; }
      let result, installedIdentity;
      try {
        installedIdentity = fs.lstatSync(note.file.path, { bigint: true });
        result = readSyncFile(note.file.path, APPLY_LIMITS.note);
      } catch { /* An unconfirmable outcome is conservative, never rolled back. */ }
      const installed = result && installedIdentity.dev === temp.stat.dev && installedIdentity.ino === temp.stat.ino && result.hash === note.afterHash && result.mode === note.file.mode;
      if (installed) {
        applied.push(note.path);
        expected.files[expected.files.findIndex((f) => f.path === note.file.path)] = fileState(result);
        expected.git.changes.push({ path: note.path, state: " M" });
        expected.git.changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      } else if (!renameError || !result || JSON.stringify(fileState(result)) !== JSON.stringify(fileState(note.file))) uncertain.push(note.path);
      if (renameError || !installed) rejectFile("replacement-error", "No se completó o confirmó un reemplazo; revisa las rutas informadas.", "error");
    }
    check();
  } catch (error) { failure = error; }
  // Never unlink a foreign inode, even when it occupies our former pathname.
  for (const artifact of artifacts.reverse()) {
    try {
      try { fs.lstatSync(artifact.path); }
      catch (error) { if (error.code !== "ENOENT") throw error; if (artifact.path === lockPath) rejectFile("artifact-conflict", "El bloqueo propio desapareció."); continue; }
      assertOwnedArtifact(artifact.path, artifact.stat); io.unlinkSync(artifact.path);
    } catch (error) { failure ??= error; }
  }
  if (!failure) { try { assertSameState(expected, capture(ignored)); } catch (error) { failure = error; } }
  const wrote = Boolean(applied.length || uncertain.length);
  const status = failure ? wrote ? "partial" : failure.code === "EEXIST" ? "conflict" : applyErrorReport(failure).status : "applied";
  const error = failure ? applyErrorReport(failure) : undefined;
  return { ...report, status, wrote, applied, uncertain, pending: report.pending.filter((p) => !applied.includes(p) && !uncertain.includes(p)),
    ...(error ? { code: failure.code === "EEXIST" ? "write-lock" : error.code, details: failure.code === "EEXIST" ? ["Existe un bloqueo o temporal ajeno; no se eliminará."] : error.details } : {}) };
}

export function formatSyncApplyReport(report) {
  return [`project-memory sync apply: ${report.status}`, ...(report.planId ? [`Plan: ${report.planId}`, `Proyecto: ${report.projectId}; PR: ${report.repository}#${report.pr}`,
    `Rama: ${report.branch}; integración: ${report.mergeCommit}`, ...report.notes.map((n) => `${n.path} (${n.state})\n${n.diff}`)] : []),
  ...(report.details ?? []), `Escribió: ${report.wrote ? "sí" : "no"}`, `Aplicadas: ${report.applied?.join(", ") || "ninguna"}`,
  `Satisfechas previamente: ${report.satisfied?.join(", ") || "ninguna"}`, `Pendientes: ${report.pending?.join(", ") || "ninguna"}`,
  `Inciertas: ${report.uncertain?.join(", ") || "ninguna"}`, report.concurrencyNotice].filter(Boolean).join("\n");
}
