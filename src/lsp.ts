/**
 * LSP client — spawns tailwindcss-language-server over stdio and speaks JSON-RPC.
 */

import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";
import { existsSync } from "fs";

const DEBUG = process.env.DEBUG === "1";

let server: ChildProcess;
let msgId = 0;

const chunks: Buffer[] = [];
let chunksLen = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

export const diagnosticsReceived = new Map<string, any[]>();
export let projectReady = false;

// ---------------------------------------------------------------------------
// Event-driven waiters — resolved by processMessages, no polling
// ---------------------------------------------------------------------------

let projectReadyResolve: (() => void) | null = null;
let diagTarget = 0;
let diagTargetResolve: (() => void) | null = null;

const diagWaiters = new Map<string, (diags: any[]) => void>();

/** Reset module state between runs (for programmatic multi-run usage). */
export function resetState() {
  msgId = 0;
  chunks.length = 0;
  chunksLen = 0;
  pending.clear();
  diagnosticsReceived.clear();
  projectReady = false;
  projectReadyResolve = null;
  diagTarget = 0;
  diagTargetResolve = null;
  diagWaiters.clear();
}

/** Returns a promise that resolves when @/tailwindCSS/projectInitialized fires. */
export function waitForProjectReady(timeoutMs = 15_000): Promise<void> {
  if (projectReady) return Promise.resolve();
  return new Promise((res, rej) => {
    projectReadyResolve = res;
    const timer = setTimeout(() => {
      projectReadyResolve = null;
      res(); // resolve anyway — don't block forever
    }, timeoutMs);
    // Clean up timer if resolved early
    const origRes = res;
    projectReadyResolve = () => { clearTimeout(timer); origRes(); };
  });
}

/** Returns a promise that resolves when diagnosticsReceived.size >= count. */
export function waitForDiagnosticCount(count: number, timeoutMs = 30_000): Promise<void> {
  if (diagnosticsReceived.size >= count) return Promise.resolve();
  return new Promise((res) => {
    diagTarget = count;
    const timer = setTimeout(() => {
      diagTargetResolve = null;
      res();
    }, timeoutMs);
    diagTargetResolve = () => { clearTimeout(timer); res(); };
  });
}

/** Returns a promise that resolves when diagnostics are published for a specific URI. */
export function waitForDiagnostic(uri: string, timeoutMs = 10_000): Promise<any[]> {
  // Clear stale entry so we wait for the server to re-publish
  diagnosticsReceived.delete(uri);
  return new Promise((res) => {
    diagWaiters.set(uri, res);
    setTimeout(() => {
      if (diagWaiters.has(uri)) {
        diagWaiters.delete(uri);
        res([]);
      }
    }, timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// JSON-RPC framing
// ---------------------------------------------------------------------------

function encode(obj: object): string {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function getRawBuf(): Buffer {
  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1) return chunks[0];
  const buf = Buffer.concat(chunks, chunksLen);
  chunks.length = 0;
  chunks.push(buf);
  return buf;
}

function setRawBuf(buf: Buffer) {
  chunks.length = 0;
  if (buf.length > 0) {
    chunks.push(buf);
    chunksLen = buf.length;
  } else {
    chunksLen = 0;
  }
}

function processMessages() {
  while (true) {
    const rawBuf = getRawBuf();
    if (rawBuf.length === 0) break;

    const str = rawBuf.toString("ascii", 0, Math.min(rawBuf.length, 256));
    const headerEnd = str.indexOf("\r\n\r\n");
    if (headerEnd === -1) { setRawBuf(rawBuf); break; }

    const headerBlock = str.slice(0, headerEnd);
    const clMatch = headerBlock.match(/Content-Length:\s*(\d+)/i);
    if (!clMatch) {
      setRawBuf(rawBuf.subarray(headerEnd + 4));
      continue;
    }

    const len = parseInt(clMatch[1], 10);
    const bodyStart = headerEnd + 4;
    if (rawBuf.length < bodyStart + len) { setRawBuf(rawBuf); break; }

    const body = rawBuf.subarray(bodyStart, bodyStart + len).toString("utf-8");
    setRawBuf(rawBuf.subarray(bodyStart + len));

    let msg: any;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }

    if (DEBUG) console.error(`<- ${msg.method || `response#${msg.id}`}`);

    // Response to our request
    if (msg.id != null && !msg.method && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(msg.error);
      else p.resolve(msg.result);
      continue;
    }

    // Server-initiated requests — must respond
    if (msg.id != null && msg.method) {
      let result: any = null;
      if (msg.method === "workspace/configuration") {
        result = (msg.params?.items || []).map(() => ({}));
      }
      server.stdin!.write(encode({ jsonrpc: "2.0", id: msg.id, result }));
      continue;
    }

    // Published diagnostics
    if (msg.method === "textDocument/publishDiagnostics" && msg.params) {
      const uri = msg.params.uri;
      const diags = msg.params.diagnostics || [];
      diagnosticsReceived.set(uri, diags);

      // Resolve URI-specific waiter
      if (diagWaiters.has(uri)) {
        const resolve = diagWaiters.get(uri)!;
        diagWaiters.delete(uri);
        resolve(diags);
      }

      // Resolve count-based waiter
      if (diagTargetResolve && diagnosticsReceived.size >= diagTarget) {
        const resolve = diagTargetResolve;
        diagTargetResolve = null;
        resolve();
      }
    }

    // Tailwind project initialized
    if (msg.method === "@/tailwindCSS/projectInitialized") {
      projectReady = true;
      if (projectReadyResolve) {
        const resolve = projectReadyResolve;
        projectReadyResolve = null;
        resolve();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

function findLanguageServer(cwd: string): string {
  const local = resolve(cwd, "node_modules/.bin/tailwindcss-language-server");
  return existsSync(local) ? local : "tailwindcss-language-server";
}

export function startServer(root: string) {
  const bin = findLanguageServer(root);
  server = spawn(bin, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"] });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      console.error("\n  \x1b[38;5;203m\x1b[1mERROR\x1b[0m @tailwindcss/language-server not found.\n");
      console.error("  Install it: npm install -D @tailwindcss/language-server\n");
      process.exit(2);
    }
  });

  server.stdout!.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    chunksLen += chunk.length;
    processMessages();
  });

  server.stderr!.on("data", (chunk: Buffer) => {
    if (DEBUG) process.stderr.write(chunk);
  });
}

export function send(method: string, params: object): Promise<any> {
  const id = ++msgId;
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    server.stdin!.write(encode({ jsonrpc: "2.0", id, method, params }));
  });
}

export function notify(method: string, params: object) {
  server.stdin!.write(encode({ jsonrpc: "2.0", method, params }));
}

export async function shutdown() {
  await send("shutdown", {}).catch(() => {});
  notify("exit", {});
  server.stdin!.end();
  server.stdout!.destroy();
  server.stderr!.destroy();
  server.kill();
}

export function fileUri(absPath: string): string {
  return `file://${absPath}`;
}

export function langId(filePath: string): string {
  if (filePath.endsWith(".css")) return "css";
  if (filePath.endsWith(".html") || filePath.endsWith(".vue") || filePath.endsWith(".svelte") || filePath.endsWith(".astro")) return "html";
  if (filePath.endsWith(".mdx")) return "mdx";
  if (filePath.endsWith(".jsx")) return "javascriptreact";
  return "typescriptreact";
}
