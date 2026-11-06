import fs from "node:fs/promises";
import path from "node:path";
import { IS_WINDOWS } from "./platform.js";

const PACKAGES = { npm: "npm", npx: "npm", codex: "@openai/codex", claude: "@anthropic-ai/claude-code" };
const NODE_EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const unavailable = () => { throw Object.assign(new Error("CLI executable unavailable"), { code: "ENOENT" }); };
const invalidBin = () => { throw Object.assign(new Error("El bin npm debe ser un archivo .js, .cjs o .mjs existente."), { code: "EINVAL" }); };

async function packageInvocation(directory, name, io, expectedScript) {
  const packageName = PACKAGES[name];
  if (!packageName) return null;
  const roots = [path.join(directory, "node_modules", packageName)];
  if (path.basename(directory).toLowerCase() === ".bin") roots.push(path.join(path.dirname(directory), packageName));
  for (const root of roots) {
    try {
      const manifestPath = path.join(root, "package.json");
      const manifestStat = await io.stat(manifestPath);
      if (!manifestStat.isFile() || manifestStat.size > 128_000) continue;
      const manifest = JSON.parse(await io.readFile(manifestPath, "utf8"));
      if (manifest.name !== packageName) continue;
      const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[name];
      if (typeof bin !== "string" || !bin || path.isAbsolute(bin) || /[\u0000-\u001f\u007f]/u.test(bin)) continue;
      if (!NODE_EXTENSIONS.has(path.extname(bin).toLowerCase())) invalidBin();
      const canonicalRoot = await io.realpath(root);
      const script = await io.realpath(path.resolve(root, bin));
      const relative = path.relative(canonicalRoot, script);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
          !NODE_EXTENSIONS.has(path.extname(script).toLowerCase()) || !(await io.stat(script)).isFile()) continue;
      if (expectedScript && script !== await io.realpath(expectedScript)) continue;
      // Never execute or interpret npm's .cmd/.ps1 shim text.
      return { executable: process.execPath, argsPrefix: [script] };
    } catch (error) { if (error.code === "EINVAL") throw error; }
  }
  return null;
}

export async function resolveCliInvocation({ name, override, environment = process.env, fileIo = fs } = {}) {
  // agy (Antigravity) is a native executable, not an npm package: only found as such on the PATH.
  const native = name === "agy";
  if (!native && !Object.hasOwn(PACKAGES, name)) unavailable();
  if (override) {
    const absolute = path.resolve(override);
    let stat;
    try { stat = await fileIo.stat(absolute); } catch { unavailable(); }
    if (!stat.isFile()) unavailable();
    if (!IS_WINDOWS) {
      if (!(stat.mode & 0o111)) unavailable();
      return { executable: absolute, argsPrefix: [] };
    }
    const extension = path.extname(absolute).toLowerCase();
    if ([".exe", ".com"].includes(extension)) return { executable: absolute, argsPrefix: [] };
    if (!native && (extension === ".cmd" || NODE_EXTENSIONS.has(extension))) {
      const directories = [path.dirname(absolute)];
      // Explicit npm bin scripts may live inside the CLI package itself.
      if (NODE_EXTENSIONS.has(extension)) {
        let current = path.dirname(absolute);
        while (path.dirname(current) !== current) {
          if (path.basename(current).toLowerCase() === "node_modules") {
            directories.push(path.dirname(current));
            break;
          }
          current = path.dirname(current);
        }
      }
      for (const directory of directories) {
        const result = await packageInvocation(directory, name, fileIo, extension === ".cmd" ? null : absolute);
        if (result) return result;
      }
    }
    unavailable();
  }
  for (const directory of (environment.PATH ?? process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const filename of IS_WINDOWS ? [`${name}.exe`, `${name}.com`] : [name]) {
      try {
        const executable = await fileIo.realpath(path.join(directory, filename));
        const stat = await fileIo.stat(executable);
        if (stat.isFile() && (IS_WINDOWS || ((stat.mode & 0o111) && !(stat.mode & 0o022)))) return { executable, argsPrefix: [] };
      } catch {}
    }
    if (IS_WINDOWS && !native) {
      const result = await packageInvocation(directory, name, fileIo);
      if (result) return result;
    }
  }
  unavailable();
}
