#!/usr/bin/env node
import { loadWithDependencyCheck } from "../src/missing-dependencies.js";

const modules = await loadWithDependencyCheck(async () => {
  const [{ serveStdio }, { createTaskWorkflowMcp }] = await Promise.all([
    import("@modelcontextprotocol/server/stdio"),
    import("../src/task-workflow-mcp.js")
  ]);
  return { serveStdio, createTaskWorkflowMcp };
});
if (modules) {
  modules.serveStdio(() => modules.createTaskWorkflowMcp(), {
    onerror() {
      process.stderr.write("agent-toolkit-mcp: error de conexión MCP\n");
    }
  });
}
