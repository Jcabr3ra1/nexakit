import path from "node:path";

import { connectMemory, ConnectionError } from "./connect.js";
import { diagnoseMemory } from "./doctor.js";
import { initializeMemory, InitializationError } from "./init.js";
import { inspectMemoryStatus } from "./status.js";
import { planMemorySync, SyncPlanningError } from "./sync.js";
import { inspectMemorySync, inspectionErrorReport, formatSyncInspectionReport } from "./sync-inspect.js";
import { recordMemorySync, recordErrorReport, formatSyncRecordReport } from "./sync-record.js";
import { applyMemorySync, applyErrorReport, formatSyncApplyReport } from "./sync-apply.js";

const HELP = `project-memory

Uso:
  project-memory init <destino> [opciones]
  project-memory connect [ruta] --agent <agente> [opciones]
  project-memory doctor [ruta] [opciones]
  project-memory status [ruta] [opciones]
  project-memory sync plan [ruta] [opciones]
  project-memory sync inspect [ruta] --pr <número> [opciones]
  project-memory sync record [ruta] --pr <número> --outcome <valor> --reviewed [opciones]
  project-memory sync apply [ruta] --proposal <archivo> [opciones]

Opciones de init:
  --project-id <id>           Identificador del proyecto.
  --project-name <nombre>     Nombre visible del proyecto.
  --description <texto>       Descripción breve de la memoria.
  --source <ruta>             Repositorio fuente existente.
  --default-branch <rama>     Rama principal; por defecto main.
  --integration-branch <rama> Rama de integración.
  --source-remote <url>       Remoto del repositorio fuente.
  --memory-remote <url>       Remoto previsto para la memoria.
  --sync-mode <modo>          none, git-manual o git-automated.
  --mcp-name <nombre>         Nombre del servidor MCP.
  --apply                     Aplica el plan; sin esta opción solo previsualiza.

Opciones de doctor:
  --manifest <ruta>  Selecciona un manifiesto concreto.
  --strict           Devuelve error cuando existan advertencias.

Opciones de connect:
  --agent <agente>   Agente a conectar: codex, claude o antigravity.
  --manifest <ruta>  Selecciona un manifiesto concreto.
  --apply            Aplica el plan; sin esta opción solo previsualiza.

Opciones de status:
  --agent <agente>   Limita la inspección a un agente declarado.
  --manifest <ruta>  Selecciona un manifiesto concreto.
  --strict           Devuelve error cuando existan advertencias.

Opciones de sync plan:
  --manifest <ruta>  Selecciona un manifiesto concreto.
  --limit <número>   Máximo de PR fusionados; por defecto 100.
  --strict           Devuelve error cuando existan PR pendientes.

Opciones de sync inspect:
  --pr <número>      PR fusionado explícito del repositorio configurado.
  --manifest <ruta>  Selecciona un manifiesto concreto.
  --max-files <n>    Máximo de archivos visibles; 200 por defecto, rango 1–1000.
  --strict           Devuelve error si la evidencia es partial o blocked.

Opciones comunes:
  --json             Imprime la salida como JSON.
  -h, --help         Muestra esta ayuda.

Opciones de sync record:
  --pr <número>          PR fusionado explícito del repositorio configurado.
  --outcome <valor>      no-documentation-change o documentation-updated.
  --reviewed            Declara que la revisión semántica está terminada.
  --summary <texto>     Resumen seguro; obligatorio cuando cambian notas.
  --note <ruta>         Nota ya actualizada, relativa y exacta; repetible.
  --ack-warning <código> text-limit o unsafe-reference revisada; repetible.
  --manifest <ruta>    Selecciona un manifiesto concreto.
  --apply               Añade únicamente la fila validada del registro.

Opciones de sync apply:
  --proposal <archivo>  Propuesta JSON revisada, externa a la bóveda.
  --manifest <ruta>     Selecciona un manifiesto concreto.
  --ack-warning <código> text-limit o unsafe-reference observada; repetible.
  --apply                Reemplaza solo las notas pendientes enumeradas.
  --reviewed             Declara revisión semántica; obligatorio al aplicar.
  --expect <sha256>     Huella de la vista previa aprobada; exige --apply.

init y connect no sobrescriben configuraciones diferentes. doctor, status,
sync plan e inspect son de solo lectura. sync record y apply escriben con --apply.
Evita editar o sincronizar la memoria durante --apply: su bloqueo no controla
editores externos. Ni record ni apply crean commits o hacen push. apply puede
quedar parcial entre notas: no revierte ni registra automáticamente el PR.`;

// Invoked as `npx nexakit memoria`, the help names that command and keeps project-memory as the compatible executable.
const DEFAULT_COMMAND = "project-memory";
function helpFor(commandName = DEFAULT_COMMAND) {
  if (commandName === DEFAULT_COMMAND) return HELP;
  return `${HELP.replaceAll(DEFAULT_COMMAND, commandName)}\n\nEl ejecutable ${DEFAULT_COMMAND} es compatible y acepta los mismos subcomandos.`;
}

export async function runCli(argv, io = defaultIo(), context = {}) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    io.out(helpFor(context.commandName));
    return 0;
  }

  const [command, ...rest] = argv;
  if (command === "doctor") {
    return runDoctorCommand(rest, io);
  }

  if (command === "init") {
    return runInitCommand(rest, io);
  }

  if (command === "connect") {
    return runConnectCommand(rest, io, context);
  }

  if (command === "status") {
    return runStatusCommand(rest, io, context);
  }

  if (command === "sync") {
    return runSyncCommand(rest, io, context);
  }

  io.err(`Comando desconocido: ${command}`);
  io.err(helpFor(context.commandName));
  return 2;
}

async function runSyncCommand(rest, io, context) {
  const [operation, ...argumentsRest] = rest;
  if (operation === "inspect") return runSyncInspectCommand(argumentsRest, io, context);
  if (operation === "record") return runSyncRecordCommand(argumentsRest, io, context);
  if (operation === "apply") return runSyncApplyCommand(argumentsRest, io, context);
  if (operation !== "plan") {
    io.err(
      operation
        ? `Operación de sync desconocida: ${operation}`
        : "Debes indicar una operación de sync: plan, inspect, record o apply."
    );
    return 2;
  }

  const options = {
    targetPath: process.cwd()
  };
  let json = false;
  let strict = false;
  let targetProvided = false;

  for (let index = 0; index < argumentsRest.length; index += 1) {
    const argument = argumentsRest[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--strict") {
      strict = true;
      continue;
    }
    if (argument === "--manifest" || argument === "--limit") {
      const value = argumentsRest[index + 1];
      if (!value || value.startsWith("--")) {
        io.err(`La opción ${argument} requiere un valor.`);
        return 2;
      }
      if (argument === "--manifest") {
        options.manifestPath = path.resolve(value);
      } else {
        options.limit = value;
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      io.err(`Opción desconocida: ${argument}`);
      return 2;
    }
    if (targetProvided) {
      io.err(`Ruta adicional no esperada: ${argument}`);
      return 2;
    }
    options.targetPath = path.resolve(argument);
    targetProvided = true;
  }

  let report;
  try {
    report = await planMemorySync(options, context);
  } catch (error) {
    if (error instanceof SyncPlanningError) {
      for (const detail of error.details) {
        io.err(`- ${detail}`);
      }
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.err(`No se pudo preparar la sincronización: ${message}`);
    return 1;
  }

  if (json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(formatSyncPlanReport(report));
  }
  return strict && report.status === "pending" ? 1 : 0;
}

async function runSyncInspectCommand(args, io, context) {
  const options = { targetPath: process.cwd() };
  const values = new Map([["--pr", "pr"], ["--manifest", "manifestPath"], ["--max-files", "maxFiles"]]);
  const seen = new Map();
  const json = args.includes("--json");
  const strict = args.includes("--strict");
  let targetProvided = false;
  const invalid = (message) => {
    const report = { command: "sync inspect", status: "error", code: "invalid-option", details: [message] };
    if (json) io.out(JSON.stringify(report, null, 2)); else io.err(message);
    return 2;
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--json" || argument === "--strict") continue;
    if (values.has(argument)) {
      const value = args[++index];
      if (!value || value.startsWith("-")) return invalid("Una opción de inspect requiere un valor válido.");
      if (seen.has(argument) && seen.get(argument) !== value) return invalid("Una opción repetida tiene valores diferentes.");
      seen.set(argument, value);
      options[values.get(argument)] = argument === "--manifest" ? path.resolve(value) : value;
      continue;
    }
    if (argument.startsWith("-")) return invalid("Opción desconocida de sync inspect.");
    if (targetProvided) return invalid("Solo se admite una ruta de memoria.");
    options.targetPath = path.resolve(argument);
    targetProvided = true;
  }
  try {
    const report = await inspectMemorySync(options, context);
    io.out(json ? JSON.stringify(report, null, 2) : formatSyncInspectionReport(report));
    return strict && report.status !== "ready" ? 1 : 0;
  } catch (error) {
    const report = inspectionErrorReport(error);
    if (json) io.out(JSON.stringify(report, null, 2)); else for (const message of report.details) io.err(`- ${message}`);
    return report.code === "invalid-option" ? 2 : 1;
  }
}

async function runSyncRecordCommand(args, io, context) {
  const options = { targetPath: process.cwd(), notes: [], ackWarnings: [] };
  const values = new Map([["--pr", "pr"], ["--outcome", "outcome"], ["--summary", "summary"],
    ["--manifest", "manifestPath"], ["--note", "notes"], ["--ack-warning", "ackWarnings"]]);
  const seen = new Map();
  const json = args.includes("--json");
  let targetProvided = false;
  const invalid = () => {
    const report = { command: "sync record", status: "error", code: "invalid-option",
      details: ["Opción desconocida, incompleta o contradictoria de sync record."], wrote: false };
    if (json) io.out(JSON.stringify(report, null, 2)); else io.err(report.details[0]);
    return 2;
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--json") continue;
    if (argument === "--apply" || argument === "--reviewed") {
      options[argument === "--apply" ? "apply" : "reviewed"] = true;
      continue;
    }
    if (values.has(argument)) {
      const value = args[++index];
      if (!value || value.startsWith("-")) return invalid();
      const key = values.get(argument);
      if (key === "notes" || key === "ackWarnings") options[key].push(value);
      else {
        if (seen.has(argument) && seen.get(argument) !== value) return invalid();
        seen.set(argument, value);
        options[key] = key === "manifestPath" ? path.resolve(value) : value;
      }
      continue;
    }
    if (argument.startsWith("-") || targetProvided) return invalid();
    options.targetPath = path.resolve(argument);
    targetProvided = true;
  }
  try {
    const report = await recordMemorySync(options, context);
    io.out(json ? JSON.stringify(report, null, 2) : formatSyncRecordReport(report));
    return ["preview", "recorded", "unchanged"].includes(report.status) ? 0 : 1;
  } catch (error) {
    const report = recordErrorReport(error);
    if (json) io.out(JSON.stringify(report, null, 2)); else io.err(formatSyncRecordReport(report));
    return report.code === "invalid-option" ? 2 : 1;
  }
}

async function runSyncApplyCommand(args, io, context) {
  const options = { targetPath: process.cwd(), ackWarnings: [] }, json = args.includes("--json"), seen = new Map();
  const values = new Map([["--proposal", "proposalPath"], ["--manifest", "manifestPath"], ["--expect", "expect"], ["--ack-warning", "ackWarnings"]]);
  let targetProvided = false;
  const invalid = () => {
    const report = { command: "sync apply", status: "error", code: "invalid-option", details: ["Opción desconocida, incompleta o contradictoria de sync apply."], wrote: false };
    if (json) io.out(JSON.stringify(report, null, 2)); else io.err(report.details[0]);
    return 2;
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") continue;
    if (arg === "--apply" || arg === "--reviewed") { options[arg.slice(2)] = true; continue; }
    if (values.has(arg)) {
      const value = args[++index]; if (!value || value.startsWith("-")) return invalid();
      const key = values.get(arg);
      if (key === "ackWarnings") options.ackWarnings.push(value);
      else { if (seen.has(arg) && seen.get(arg) !== value) return invalid(); seen.set(arg, value); options[key] = value; }
      continue;
    }
    if (arg.startsWith("-") || targetProvided) return invalid();
    options.targetPath = path.resolve(arg); targetProvided = true;
  }
  try {
    const report = await applyMemorySync(options, context);
    io.out(json ? JSON.stringify(report, null, 2) : formatSyncApplyReport(report));
    return ["preview", "applied", "unchanged"].includes(report.status) ? 0 : 1;
  } catch (error) {
    const report = applyErrorReport(error);
    if (json) io.out(JSON.stringify(report, null, 2)); else io.err(formatSyncApplyReport(report));
    return report.code === "invalid-option" ? 2 : 1;
  }
}

async function runStatusCommand(rest, io, context = {}) {
  const options = {
    targetPath: process.cwd()
  };
  let json = false;
  let strict = false;
  let targetProvided = false;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];

    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--strict") {
      strict = true;
      continue;
    }
    if (argument === "--agent" || argument === "--manifest") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        io.err(`La opción ${argument} requiere un valor.`);
        return 2;
      }
      if (argument === "--agent") {
        options.agentId = value;
      } else {
        options.manifestPath = path.resolve(value);
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      io.err(`Opción desconocida: ${argument}`);
      return 2;
    }
    if (targetProvided) {
      io.err(`Ruta adicional no esperada: ${argument}`);
      return 2;
    }
    options.targetPath = path.resolve(argument);
    targetProvided = true;
  }

  let report;
  try {
    report = await inspectMemoryStatus(options, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`No se pudo inspeccionar el estado: ${message}`);
    return 1;
  }

  if (json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(formatStatusReport(report));
  }

  if (report.status === "error") {
    return 1;
  }
  if (strict && report.status === "warning") {
    return 1;
  }
  return 0;
}

async function runConnectCommand(rest, io, context = {}) {
  const options = {
    apply: false,
    targetPath: process.cwd()
  };
  let json = false;
  let targetProvided = false;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];

    if (argument === "--apply") {
      options.apply = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--agent" || argument === "--manifest") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        io.err(`La opción ${argument} requiere un valor.`);
        return 2;
      }
      if (argument === "--agent") {
        options.agentId = value;
      } else {
        options.manifestPath = path.resolve(value);
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      io.err(`Opción desconocida: ${argument}`);
      return 2;
    }
    if (targetProvided) {
      io.err(`Ruta adicional no esperada: ${argument}`);
      return 2;
    }
    options.targetPath = path.resolve(argument);
    targetProvided = true;
  }

  let report;
  try {
    report = await connectMemory(options, context);
  } catch (error) {
    if (error instanceof ConnectionError) {
      for (const detail of error.details) {
        io.err(`- ${detail}`);
      }
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.err(`No se pudo preparar la conexión: ${message}`);
    return 1;
  }

  if (json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(formatConnectReport(report));
  }
  return report.status === "conflict" ? 1 : 0;
}

async function runDoctorCommand(rest, io) {

  let targetPath = process.cwd();
  let manifestPath;
  let json = false;
  let strict = false;
  let targetProvided = false;

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];

    if (argument === "--json") {
      json = true;
      continue;
    }

    if (argument === "--strict") {
      strict = true;
      continue;
    }

    if (argument === "--manifest") {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        io.err("La opción --manifest requiere una ruta.");
        return 2;
      }
      manifestPath = path.resolve(value);
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      io.err(`Opción desconocida: ${argument}`);
      return 2;
    }

    if (targetProvided) {
      io.err(`Ruta adicional no esperada: ${argument}`);
      return 2;
    }

    targetPath = path.resolve(argument);
    targetProvided = true;
  }

  let report;
  try {
    report = await diagnoseMemory(targetPath, { manifestPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`No se pudo completar el diagnóstico: ${message}`);
    return 1;
  }

  if (json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(formatReport(report));
  }

  if (report.status === "error") {
    return 1;
  }

  if (strict && report.status === "warning") {
    return 1;
  }

  return 0;
}

function runInitCommand(rest, io) {
  const options = {
    apply: false
  };
  let json = false;
  let destinationProvided = false;
  const valueOptions = new Map([
    ["--project-id", "projectId"],
    ["--project-name", "projectName"],
    ["--source", "sourcePath"],
    ["--default-branch", "defaultBranch"],
    ["--integration-branch", "integrationBranch"],
    ["--source-remote", "sourceRemote"],
    ["--memory-remote", "memoryRemote"],
    ["--sync-mode", "syncMode"],
    ["--mcp-name", "mcpName"],
    ["--description", "description"]
  ]);

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];

    if (argument === "--apply") {
      options.apply = true;
      continue;
    }

    if (argument === "--json") {
      json = true;
      continue;
    }

    if (valueOptions.has(argument)) {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) {
        io.err(`La opción ${argument} requiere un valor.`);
        return 2;
      }
      options[valueOptions.get(argument)] = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      io.err(`Opción desconocida: ${argument}`);
      return 2;
    }

    if (destinationProvided) {
      io.err(`Destino adicional no esperado: ${argument}`);
      return 2;
    }

    options.destination = path.resolve(argument);
    destinationProvided = true;
  }

  let report;
  try {
    report = initializeMemory(options);
  } catch (error) {
    if (error instanceof InitializationError) {
      for (const detail of error.details) {
        io.err(`- ${detail}`);
      }
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.err(`No se pudo preparar la memoria: ${message}`);
    return 1;
  }

  if (json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    io.out(formatInitReport(report));
  }

  return report.status === "conflict" ? 1 : 0;
}

function formatInitReport(report) {
  const lines = [
    `Project Memory Init: ${report.status.toUpperCase()}`,
    `Modo: ${report.mode}`,
    `Destino: ${report.destination}`,
    `Proyecto: ${report.project.name} (${report.project.id})`,
    "",
    `${report.summary.create} por crear, ${report.summary.unchanged} sin cambios, ${report.summary.conflicts} conflictos`
  ];

  for (const file of report.files) {
    const symbol = file.action === "create" ? "+" : file.action === "unchanged" ? "=" : "!";
    lines.push(`${symbol} ${file.path}${file.reason ? ` — ${file.reason}` : ""}`);
  }

  if (report.status === "preview") {
    lines.push("");
    lines.push("Vista previa: repite el comando con --apply para crear los archivos.");
  }

  return lines.join("\n");
}

function formatConnectReport(report) {
  const lines = [
    `Project Memory Connect: ${report.status.toUpperCase()}`,
    `Modo: ${report.mode}`,
    `Agente: ${report.agent}`,
    `Bóveda: ${report.vaultPath}`,
    `MCP: ${report.mcpName}`,
    `Skill: ${report.skillName}`,
    "",
    `${report.summary.create} por crear, ${report.summary.update} por actualizar, ${report.summary.unchanged} sin cambios, ${report.summary.conflicts} conflictos`
  ];

  const symbols = {
    create: "+",
    update: "~",
    unchanged: "=",
    conflict: "!"
  };
  for (const component of report.components) {
    lines.push(
      `${symbols[component.action]} ${component.id}: ${component.message}${component.path ? ` (${component.path})` : ""}`
    );
  }
  if (report.status === "preview") {
    lines.push("");
    lines.push("Vista previa: repite el comando con --apply para conectar el agente.");
  }
  return lines.join("\n");
}

function formatStatusReport(report) {
  const lines = [
    `Project Memory Status: ${report.status.toUpperCase()}`,
    `Proyecto: ${report.project?.name ?? "no determinado"}${report.project?.id ? ` (${report.project.id})` : ""}`,
    `Manifiesto: ${report.manifestPath ?? "no encontrado"}`,
    `Bóveda: ${report.memory.vaultPath ?? "no determinada"}`,
    `Memoria: ${report.memory.status.toUpperCase()} — ${report.memory.summary.errors} errores, ${report.memory.summary.warnings} advertencias`,
    ""
  ];

  const symbols = {
    ok: "✓",
    warning: "!",
    error: "✗",
    disabled: "-"
  };
  for (const agent of report.agents) {
    lines.push(`${symbols[agent.status]} ${agent.id}: ${agent.summary}`);
    for (const component of agent.components) {
      if (component.action !== "unchanged") {
        lines.push(`    - ${component.id}: ${component.message}`);
      }
    }
    for (const detail of agent.details ?? []) {
      lines.push(`    - ${detail}`);
    }
  }

  for (const finding of report.findings) {
    lines.push(`${symbols[finding.level] ?? "!"} ${finding.message}`);
    for (const detail of finding.details ?? []) {
      lines.push(`    - ${detail}`);
    }
  }

  lines.push("");
  lines.push(
    `${report.summary.errors} errores, ${report.summary.warnings} advertencias, ${report.summary.healthyAgents} agentes saludables, ${report.summary.pendingAgents} pendientes`
  );
  return lines.join("\n");
}

function formatSyncPlanReport(report) {
  const lines = [
    `Project Memory Sync Plan: ${report.status.toUpperCase()}`,
    `Repositorio: ${report.repository}`,
    `Rama revisada: ${report.branch}`,
    `Registro: ${report.ledgerPath}`,
    `Línea base: ${report.baseline ? `#${report.baseline.number} (${report.baseline.mergedAt})` : "no disponible"}`,
    "",
    `${report.reviewed.length} PR revisados, ${report.pending.length} pendientes`
  ];

  for (const pullRequest of report.pending) {
    lines.push(
      `#${pullRequest.number} ${pullRequest.title} — ${pullRequest.mergedAt}`
    );
    lines.push(`    ${pullRequest.url}`);
  }
  if (report.pending.length === 0) {
    lines.push("No hay Pull Requests fusionados pendientes de revisión.");
  }
  return lines.join("\n");
}

function formatReport(report) {
  const lines = [
    `Project Memory Doctor: ${report.status.toUpperCase()}`,
    `Manifiesto: ${report.manifestPath ?? "no encontrado"}`,
    `Repositorio fuente: ${report.sourcePath ?? "no determinado"}`,
    `Bóveda: ${report.vaultPath ?? "no determinada"}`,
    `Estructura: ${report.layoutProfile ?? "no determinada"}`,
    ""
  ];

  const symbols = {
    pass: "✓",
    info: "i",
    warning: "!",
    error: "✗"
  };

  for (const check of report.checks) {
    lines.push(`${symbols[check.level]} [${check.id}] ${check.message}`);
    for (const detail of check.details ?? []) {
      lines.push(`    - ${detail}`);
    }
  }

  lines.push("");
  lines.push(
    `${report.summary.errors} errores, ${report.summary.warnings} advertencias, ${report.summary.passed} comprobaciones correctas`
  );

  return lines.join("\n");
}

function defaultIo() {
  return {
    out(message) {
      console.log(message);
    },
    err(message) {
      console.error(message);
    }
  };
}
