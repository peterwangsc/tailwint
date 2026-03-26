/**
 * LSP client — spawns tailwindcss-language-server over stdio and speaks JSON-RPC.
 */

import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";

const DEBUG = process.env.DEBUG === "1";

let workspaceRoot = "";
let vscodeSettings: Record<string, any> | null = null;

/** Load .vscode/settings.json once, cache the result. */
function loadVscodeSettings(): Record<string, any> {
  if (vscodeSettings !== null) return vscodeSettings;
  const settingsPath = resolve(workspaceRoot, ".vscode/settings.json");
  if (!existsSync(settingsPath)) {
    vscodeSettings = {};
    return vscodeSettings;
  }
  try {
    // Strip single-line comments (// ...) and trailing commas for JSON compat
    const raw = readFileSync(settingsPath, "utf-8")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/,\s*([\]}])/g, "$1");
    vscodeSettings = JSON.parse(raw);
  } catch {
    vscodeSettings = {};
  }
  return vscodeSettings!;
}

/**
 * Extract a section from flat VS Code settings into a nested object.
 * e.g. section "tailwindCSS" turns { "tailwindCSS.lint.cssConflict": "error" }
 * into { lint: { cssConflict: "error" } }
 */
function getSettingsSection(section: string): Record<string, any> {
  const settings = loadVscodeSettings();
  const prefix = section + ".";
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(prefix)) continue;
    const path = key.slice(prefix.length).split(".");
    let target = result;
    for (let i = 0; i < path.length - 1; i++) {
      if (!(path[i] in target) || typeof target[path[i]] !== "object") {
        target[path[i]] = {};
      }
      target = target[path[i]];
    }
    target[path[path.length - 1]] = value;
  }
  return result;
}

let server: ChildProcess;
let serverDead = false;
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
  serverDead = false;
  chunks.length = 0;
  chunksLen = 0;
  pending.clear();
  diagnosticsReceived.clear();
  projectReady = false;
  projectReadyResolve = null;
  diagTarget = 0;
  diagTargetResolve = null;
  diagWaiters.clear();
  vscodeSettings = null;
}

/** Returns a promise that resolves when @/tailwindCSS/projectInitialized fires. */
export function waitForProjectReady(timeoutMs = 15_000): Promise<void> {
  if (projectReady || serverDead) return Promise.resolve();
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
  if (diagnosticsReceived.size >= count || serverDead) return Promise.resolve();
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
  if (serverDead) return Promise.resolve([]);
  // Clear stale entry so we wait for the server to re-publish
  diagnosticsReceived.delete(uri);
  return new Promise((res) => {
    const timer = setTimeout(() => {
      if (diagWaiters.has(uri)) {
        diagWaiters.delete(uri);
        res([]);
      }
    }, timeoutMs);
    diagWaiters.set(uri, (diags) => { clearTimeout(timer); res(diags); });
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
        result = (msg.params?.items || []).map((item: any) =>
          item.section ? getSettingsSection(item.section) : {},
        );
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

/** Reject all pending requests and resolve all waiters. Called when the server dies. */
function drainAll(reason: Error) {
  serverDead = true;
  for (const [id, p] of pending) {
    p.reject(reason);
    pending.delete(id);
  }
  // Resolve project-ready waiter (so run() doesn't hang)
  if (projectReadyResolve) {
    const r = projectReadyResolve;
    projectReadyResolve = null;
    r();
  }
  // Resolve count-based waiter
  if (diagTargetResolve) {
    const r = diagTargetResolve;
    diagTargetResolve = null;
    r();
  }
  // Resolve all URI-specific waiters with empty arrays
  for (const [uri, r] of diagWaiters) {
    r([]);
  }
  diagWaiters.clear();
}

export function startServer(root: string) {
  workspaceRoot = root;
  const bin = findLanguageServer(root);
  server = spawn(bin, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"] });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      console.error("\n  \x1b[38;5;203m\x1b[1mERROR\x1b[0m @tailwindcss/language-server not found.");
      console.error("  Install it: \x1b[1mnpm install -D @tailwindcss/language-server\x1b[0m\n");
    }
    drainAll(new Error(err.code === "ENOENT"
      ? "@tailwindcss/language-server not found"
      : `language server error: ${err.message}`));
  });

  server.on("close", (code, signal) => {
    if (!serverDead) {
      drainAll(new Error(
        signal ? `language server killed by ${signal}` : `language server exited with code ${code}`,
      ));
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
  if (serverDead) return Promise.reject(new Error("language server is not running"));
  const id = ++msgId;
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    try {
      server.stdin!.write(encode({ jsonrpc: "2.0", id, method, params }));
    } catch {
      pending.delete(id);
      rej(new Error("language server is not running"));
    }
  });
}

export function notify(method: string, params: object) {
  if (serverDead) return;
  try {
    server.stdin!.write(encode({ jsonrpc: "2.0", method, params }));
  } catch {
    // Server pipe is dead — drainAll will handle cleanup via the close event
  }
}

export async function shutdown() {
  if (serverDead) return;
  await send("shutdown", {}).catch(() => {});
  notify("exit", {});
  serverDead = true;
  try { server.stdin!.end(); } catch {}
  try { server.stdout!.destroy(); } catch {}
  try { server.stderr!.destroy(); } catch {}
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
