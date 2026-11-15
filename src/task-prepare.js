import { isPortableAbsolutePath, toGitPath } from './platform.js';
import path from "node:path";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import { copyInertJson } from "./client-output-json.js";
import { copyTaskJson, TASK_LIMITS } from "./task-document.js";
import { createModelSelector } from "./model-selection.js";
import { containsSensitiveData, isCredentialPath } from "./sensitive-data.js";

// copyTaskJson y TASK_LIMITS viven en task-document.js; se reexportan mientras existan sus importadores.
export { copyTaskJson, TASK_LIMITS };

export const TASK_SCHEMA_ID = "https://agent-toolkit.local/schemas/agent-task-prepare.schema.json";
export const TASK_FACTS = Object.freeze({ executed: false, sent: false, wrote: false, permissionVerified: false,
  sourceBaseVerified: false, runtimeReady: false, verifiedAdmission: false, modelVerification: "unknown" });
const BASE_ID = "https://agent-toolkit.local/schemas/agent-model-selection.schema.json";
const PREF_ID = "https://agent-toolkit.local/schemas/agent-model-preference.schema.json";
const canonical = v => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ?
  `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
export const taskHash = v => createHash("sha256").update(canonical(v)).digest("hex");
const pathKey = s => s.normalize("NFC").toLowerCase();
const credentialReference = value => { const s = toGitPath(value); return isCredentialPath(s) || /(?:^|\/)(?:\.(?:credentials?|secrets?)(?:\.[^/]*)?)(?:\/|$)/i.test(s) || /\.keychain(?:-db)?$/i.test(s); };
export function taskRelativePath(s, dot = false) {
  return typeof s === "string" && (dot && s === "." || s.length > 0 && s.length <= 512 && s === s.trim() &&
    !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\\:*?\[\]<>|`]/u.test(s) &&
    s.split("/").every(p => p && ![".", "..", ".git", ".obsidian"].includes(p.toLowerCase())) &&
    !credentialReference(s) && !containsSensitiveData(s));
}
function sensitive(v) {
  return typeof v === "string" ? containsSensitiveData(v) : v !== null && typeof v === "object" &&
    Object.keys(v).some(k => containsSensitiveData(k) || sensitive(v[k]));
}
const timestamp = v => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) && Number.isFinite(Date.parse(v)) &&
  new Date(Date.parse(v)).toISOString() === v.replace(/Z$/, ".000Z");
function semanticReasons(t, r) {
  const invalid = [], blocked = [], add = (list, code) => { if (!list.includes(code)) list.push(code); };
  if (["projectId", "taskId", "revision", "role", "mode"].some(k => t.identity[k] !== r[k])) add(invalid, "task-identity-conflict");
  const root = t.base.repositoryRoot;
  if (!isPortableAbsolutePath(root) || /[\x00-\x1f]/.test(root) || credentialReference(root)) add(invalid, "task-path-invalid");
  const checkPaths = (entries, key = "path") => {
    const seen = new Set(); for (const e of entries) {
      if (!taskRelativePath(e[key]) || seen.has(pathKey(e[key]))) add(invalid, "task-path-invalid");
      seen.add(pathKey(e[key]));
    }
  };
  checkPaths(t.scope.files); checkPaths(t.base.initialGitState);
  if (t.checks.some(c => !taskRelativePath(c.directory, true))) add(invalid, "task-path-invalid");
  if (t.scope.files.some(f => (f.operation === "create") !== (f.expectedBase === "absent"))) add(invalid, "task-base-conflict");
  const ids = new Set(); for (const c of [...t.base.instructionRefs, ...t.contextRefs]) {
    if (ids.has(c.id)) add(invalid, "task-reference-conflict"); ids.add(c.id);
    if (credentialReference(c.locator)) add(blocked, "task-credential-reference");
  }
  if (t.base.instructionRefs.some(c => c.kind !== "instructions")) add(invalid, "task-reference-conflict");
  if (new Set(t.criteria.map(c => c.id)).size !== t.criteria.length) add(invalid, "task-criteria-conflict");
  const revision = Number(t.identity.revision.slice(1));
  for (const d of [...t.previousDeliveries, ...(t.proposalRef ? [t.proposalRef] : [])]) {
    if (Number(d.revision.slice(1)) > revision) add(invalid, "task-history-conflict");
    if (credentialReference(d.locator)) add(blocked, "task-credential-reference");
  }
  if (!t.projectRules.allowedModes.includes(t.identity.mode)) add(blocked, "task-mode-not-permitted");
  if (t.identity.mode === "tutor" && (!t.step || t.projectRules.activeWriter !== "user" || t.identity.role === "executor")) add(blocked, "task-tutor-authorship-conflict");
  if (t.identity.mode === "autonomous" && t.step !== null) add(invalid, "task-step-conflict");
  if (t.identity.purpose === "external-verifier") {
    const actions = r.authorizationContext?.allowedActions ?? [];
    const listedPaths = new Set(t.scope.files.map(f => pathKey(f.path)));
    const references = [...t.base.instructionRefs, ...t.contextRefs, ...t.previousDeliveries, ...(t.proposalRef ? [t.proposalRef] : [])];
    const referencesListed = references.every(ref => taskRelativePath(ref.locator) && listedPaths.has(pathKey(ref.locator)));
    if (t.identity.role !== "reviewer" || t.identity.mode !== "autonomous") add(invalid, "task-external-verifier-identity");
    if (t.scope.files.some(f => f.operation !== "inspect") || !referencesListed || t.checks.length ||
      actions.length !== 2 || !actions.includes("read") || !actions.includes("verify") ||
      !t.projectRules.forbiddenActions.includes("apply") || !t.projectRules.forbiddenActions.includes("propose")) {
      add(blocked, "task-external-verifier-scope");
    }
  }
  if (r.authorizationContext) {
    const a = r.authorizationContext;
    if (a.activeWriter !== t.projectRules.activeWriter) add(blocked, "task-writer-conflict");
    if (a.allowedActions.some(action => t.projectRules.forbiddenActions.includes(action))) add(blocked, "task-action-not-permitted");
  }
  if (r.history && (r.history.executionsUsed || r.history.durationUsedSeconds || r.history.correctionRound) && !t.previousDeliveries.length) add(blocked, "task-history-reference-required");
  if (t.identity.role === "executor" && !t.proposalRef) add(blocked, "task-proposal-reference-required");
  if (t.scope.files.some(f => f.operation !== "inspect" && t.base.initialGitState.some(s => pathKey(s.path) === pathKey(f.path) && s.owner !== "task"))) add(blocked, "task-local-overlap");
  return { invalid, blocked };
}
// No data string can introduce headings, HTML, fences, links or terminal controls.
const dataBlock = v => "```json\n" + JSON.stringify(v, null, 2).replace(/"(?:\\.|[^"\\])*"/gu,
  token => token.replace(/[<>&`()\[\]\u2028\u2029]/gu,
    c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))) + "\n```\n";
function render(t, r, selection) {
  const section = (title, value) => `\n## ${title}\n\n${dataBlock(value)}`;
  const externalVerifier = t.identity.purpose === "external-verifier";
  return "# Encargo — borrador pendiente de revisión\n\n" +
    "No enviado ni autorizado por esta herramienta. Datos declarados: revisar permiso directo, instrucciones y base antes de actuar. No cambiar de proveedor para evadir bloqueos.\n" +
    section("Identidad y estado", { ...t.identity, status: "draft", step: t.step }) +
    section("Objetivo, alcance y exclusiones", { title: t.title, objective: t.objective, scope: t.scope }) +
    section("Base e instrucciones declaradas — no verificadas", { ...t.base, projectRules: t.projectRules }) +
    section("Contexto por referencia — no leído", t.contextRefs) +
    section("Autorización declarada — no demuestra permiso", { declared: r.authorizationContext, permissionVerified: false,
      gitMemoryDeploymentBilling: "not-authorized-by-preparation" }) +
    section("Selección por destinatario — elegir manualmente", { ...selection, observedModels: [], modelVerification: "unknown",
      availabilityCurrentVerified: false, evaluationTimeDeclared: r.evaluationTime, decisionFileSha256: null }) +
    section("Historial y límites — no reiniciados", { history: r.history, previousDeliveries: t.previousDeliveries, proposalRef: t.proposalRef }) +
    section("Criterios y comprobaciones declaradas — no ejecutadas", { criteria: t.criteria, checks: t.checks }) +
    section("Entrega solicitada", { instructions: externalVerifier ?
      "Entrega únicamente hallazgos basados en los archivos enumerados. No edites, crees ni borres archivos; no ejecutes comandos. Si el cliente no puede imponer acceso de solo lectura, no ejecutes este encargo." : t.deliveryInstructions,
      modeRule: externalVerifier ?
        "Verificador externo: rol reviewer, modo autonomous, acciones limitadas a read y verify, archivos únicamente inspect. El borrador no impone controles al cliente receptor; el sistema de ejecución debe aplicar solo lectura." :
        t.identity.mode === "tutor" ?
          "Un único paso; el usuario escribe y se revisa antes de avanzar. El tutor no aplica código." :
          "Propuesta, aplicación y revisión necesitan decisiones separadas y permiso directo para cada rol. Sin envío ni ejecución automática." });
}
export function createTaskPreparer(taskSchema, baseSchema, preferenceSchema) {
  let s, b, p, validInput, validReport, validSummary, validSelection, select;
  try {
    [s, b, p] = [taskSchema, baseSchema, preferenceSchema].map(copyInertJson);
    if (s.$id !== TASK_SCHEMA_ID || b.$id !== BASE_ID || p.$id !== PREF_ID) throw Error();
    const ajv = new Ajv2020({ strict: true, allErrors: false }); ajv.addFormat("date-time", { type: "string", validate: timestamp });
    [b, p, s].forEach(x => ajv.addSchema(x));
    validInput = ajv.compile({ $ref: TASK_SCHEMA_ID + "#/$defs/input" });
    validReport = ajv.compile({ $ref: TASK_SCHEMA_ID + "#/$defs/report" });
    validSummary = ajv.compile({ $ref: TASK_SCHEMA_ID + "#/$defs/summary" });
    validSelection = ajv.compile({ $ref: TASK_SCHEMA_ID + "#/$defs/selection" });
    select = createModelSelector(b, p);
  } catch { throw Error("Invalid trusted task schemas"); }
  const auditBase = { taskSchemaSha256: taskHash(s), baseSchemaSha256: taskHash(b), preferenceSchemaSha256: taskHash(p) };
  const prepare = input => {
    const out = { command: "agent-task prepare", schemaVersion: "1.0.0", state: "invalid", selectionState: null,
      identity: null, selection: null, brief: null, reasons: [], missing: [],
      audit: { ...auditBase, taskSha256: null, sourceByteHashes: null }, ...TASK_FACTS, observedModels: [] };
    const finish = (state, codes) => {
      out.state = state; out.reasons = [...new Set(codes)].sort();
      if (state !== "prepared-draft") out.brief = null;
      if (!validReport(out)) throw Error("Task preparation invariant failed"); return out;
    };
    let data;
    try { data = copyTaskJson(input); } catch { return finish("invalid", ["task-invalid-input"]); }
    if (!validInput(data)) return finish("invalid", ["task-invalid-input"]);
    if (sensitive(data)) return finish("blocked", ["task-sensitive-input"]);
    const { task, request, catalog, policy } = data;
    out.identity = copyInertJson(task.identity); out.audit.taskSha256 = taskHash(task);
    const reasons = semanticReasons(task, request);
    if (reasons.invalid.length) return finish("invalid", reasons.invalid);
    if (reasons.blocked.length) return finish("blocked", reasons.blocked);
    const result = select({ request, catalog, policy }); out.selectionState = result.state;
    // Project only the v2 contract, not arbitrary unknown input properties.
    out.selection = Object.fromEntries(["state", "selectorVersion", "recommendation", "constraints", "audit", "reasons", "missing", "issues", "excluded", "effortExcluded"].map(k => [k, result[k]]));
    try { copyTaskJson(out.selection); if (!validSelection(out.selection)) throw Error(); }
    catch { out.selection = null; return finish("invalid", ["task-output-limit"]); }
    out.missing = [...result.missing];
    if (result.state !== "recommended") return finish(result.state, ["task-selection-" + result.state]);
    try {
      const text = render(task, request, out.selection);
      if (Buffer.byteLength(text) > TASK_LIMITS.briefBytes) throw Error();
      out.brief = text;
    } catch { out.selection = null; return finish("invalid", ["task-output-limit"]); }
    return finish("prepared-draft", ["task-prepared-draft"]);
  };
  return Object.freeze({ prepareTask: prepare, summarize(report) {
    const r = copyInertJson(report); if (!validReport(r)) throw Error("Invalid task preparation report");
    const m = r.selection?.recommendation;
    const summary = { command: r.command, state: r.state, selectionState: r.selectionState, identity: r.identity,
      recommended: m ? Object.fromEntries(["provider", "client", "requestedModel", "familyId", "versionOrdinal", "effort"].map(k => [k, m[k]])) : null,
      reasons: r.reasons, missing: r.missing, availabilityCurrentVerified: false, ...TASK_FACTS, observedModels: [] };
    if (!validSummary(summary) || Buffer.byteLength(JSON.stringify(summary)) > TASK_LIMITS.summaryBytes) throw Error("Task summary limit");
    return summary;
  } });
}
