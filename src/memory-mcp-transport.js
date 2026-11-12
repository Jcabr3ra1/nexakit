import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/server";
import { MEMORY_MCP_LIMITS, MemoryMcpError } from "./memory-mcp-policy.js";
import { decode, parseEventJson } from "./client-output-json.js";

/** Byte-framed STDIO: limits apply to each message, not a batch of valid lines. */
export class MemoryMcpTransport {
  constructor(input, output, hooks = {}) {
    this.input = input; this.output = output; this.hooks = hooks;
    this.parts = []; this.bytes = 0; this.closed = false; this.started = false;
    this.data = chunk => this.accept(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    this.end = () => { void this.close(); };
    this.error = () => this.fail("RG_PROTOCOL_ERROR");
  }
  async start() {
    if (this.started || this.closed) throw new MemoryMcpError("RG_PROTOCOL_ERROR");
    this.started = true;
    this.input.on("data", this.data); this.input.on("end", this.end); this.input.on("error", this.error);
  }
  fail(code) { this.hooks.onFatal?.(code); this.onerror?.(new MemoryMcpError(code, true)); void this.close(); }
  accept(chunk) {
    if (this.closed) return;
    let offset = 0;
    while (offset < chunk.length && !this.closed) {
      const newline = chunk.indexOf(10, offset), stop = newline === -1 ? chunk.length : newline;
      this.bytes += stop - offset;
      if (this.bytes > MEMORY_MCP_LIMITS.requestBytes) { this.fail("RG_INPUT_LIMIT"); return; }
      this.parts.push(chunk.subarray(offset, stop));
      if (newline === -1) return;
      const bytes = Buffer.concat(this.parts, this.bytes); this.parts = []; this.bytes = 0;
      try {
        // Reject invalid UTF-8 and duplicate JSON keys before SDK dispatch.
        const message = deserializeMessage(JSON.stringify(parseEventJson(decode(bytes))));
        if ("id" in message && !(Number.isSafeInteger(message.id) || typeof message.id === "string" && message.id.length <= 128)) throw Error();
        if ("method" in message && (message.method.length > 128 || /[\x00-\x1f]/.test(message.method))) throw Error();
        this.onmessage?.(message);
      } catch { this.fail("RG_PROTOCOL_ERROR"); return; }
      offset = newline + 1;
    }
  }
  async send(message) {
    if (this.closed) throw new MemoryMcpError("RG_SESSION_CLOSED");
    if (message.error) {
      const code = message.error.message.match(/^(?:MCP error -\d+: )?(RG_[A-Z_]+)$/)?.[1];
      message = { jsonrpc: "2.0", id: message.id, error: { code: message.error.code, message: code ?? "RG_PROTOCOL_ERROR" } };
    }
    const line = serializeMessage(message);
    if (Buffer.byteLength(line) > MEMORY_MCP_LIMITS.responseBytes) { this.fail("RG_RESPONSE_LIMIT"); throw new MemoryMcpError("RG_RESPONSE_LIMIT", true); }
    await new Promise((resolve, reject) => {
      try { this.output.write(line, error => error ? reject(new MemoryMcpError("RG_PROTOCOL_ERROR", true)) : resolve()); }
      catch { reject(new MemoryMcpError("RG_PROTOCOL_ERROR", true)); }
    });
  }
  async close() {
    if (this.closed) return; this.closed = true; this.parts = []; this.bytes = 0;
    this.input.off("data", this.data); this.input.off("end", this.end); this.input.off("error", this.error);
    if (!this.input.listenerCount("data")) this.input.pause();
    this.onclose?.(); this.hooks.onClose?.();
  }
}
