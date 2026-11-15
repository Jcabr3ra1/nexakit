#!/usr/bin/env node
import { loadWithDependencyCheck } from "../src/missing-dependencies.js";

const mcp = await loadWithDependencyCheck(() => import("../dist/fabrica/mcp.js"));
if (mcp) {
  try {
    await mcp.ejecutarServidorMcp();
  } catch {
    process.stderr.write("nexakit-fabrica-mcp: error de conexión MCP\n");
    process.exitCode = 1;
  }
}
