// Lectura y validación estricta de documentos JSON de entrada (manifiestos y esquemas).
// Vive aparte para que memory-mcp-policy no dependa del flujo task-*.
import { decode, copyBytes, parseEventJson, copyInertJson } from "./client-output-json.js";

export const TASK_LIMITS = Object.freeze({ fileBytes: 524288, totalBytes: 2097152, nodes: 30000, depth: 32,
  textBytes: 2000000, briefBytes: 131072, summaryBytes: 8192 });
const control = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u;

export function copyTaskJson(input) {
  const v = copyInertJson(input); let nodes = 0, textBytes = 0;
  function walk(x, depth) {
    if (++nodes > TASK_LIMITS.nodes || depth > TASK_LIMITS.depth) throw Error("Task data limit");
    if (typeof x === "string") {
      textBytes += Buffer.byteLength(x); if (Buffer.from(x, "utf8").toString("utf8") !== x || control.test(x)) throw Error("Task text invalid");
    } else if (x !== null && typeof x === "object") for (const k of Object.keys(x)) {
      textBytes += Buffer.byteLength(k); if (control.test(k) || Buffer.from(k, "utf8").toString("utf8") !== k) throw Error("Task key invalid");
      walk(x[k], depth + 1);
    }
    if (textBytes > TASK_LIMITS.textBytes) throw Error("Task data limit");
  }
  walk(v, 0); return v;
}

export class TaskInputError extends Error {
  constructor(code) { super("Task input rejected"); this.code = code; }
}
export const reject = code => { throw new TaskInputError(code); };

// Compare decimal values after their shortest JSON round trip, not binary-rational exactness.
function decimalIdentity(token) {
  const [m, exp = "0"] = token.toLowerCase().split("e");
  const minus = m.startsWith("-"), fraction = m.split(".")[1]?.length ?? 0;
  let digits = m.replace(/[-.]/g, "").replace(/^0+/, ""); if (!digits) return "0";
  let scale = Number(exp) - fraction;
  if (!Number.isSafeInteger(scale)) reject("task-file-format");
  const trailing = digits.length - digits.replace(/0+$/, "").length;
  digits = digits.slice(0, digits.length - trailing); scale += trailing;
  return (minus ? "-" : "") + digits + "e" + scale;
}
function checkNumbers(text) {
  let string = false, escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (string) { if (escape) escape = false; else if (c === "\\") escape = true; else if (c === '"') string = false; continue; }
    if (c === '"') { string = true; continue; }
    if (c === "-" || /[0-9]/.test(c)) {
      const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i)); if (!m) reject("task-file-format");
      const n = Number(m[0]);
      if (!Number.isFinite(n) || Number.isInteger(n) && !Number.isSafeInteger(n) || decimalIdentity(m[0]) !== decimalIdentity(String(n))) reject("task-file-format");
      i += m[0].length - 1;
    }
  }
}
export function parseTaskDocument(bytes) {
  try {
    const text = decode(copyBytes(bytes, TASK_LIMITS.fileBytes)); checkNumbers(text);
    return copyTaskJson(parseEventJson(text));
  } catch { reject("task-file-format"); }
}
