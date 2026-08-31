/**
 * LSP client — spawns tailwindcss-language-server over stdio and speaks JSON-RPC.
 */

import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";
import { pathToFileURL } from "url";
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
let lastInitMs = 0;
let inBrokenSequence = false;

export const warnings: string[] = [];

let allFilesWaitResolve: (() => void) | null = null;
let allFilesWaitReject: ((error: Error) => void) | null = null;
const expectedDiagnosticUris = new Set<string>();
let outerTimer: ReturnType<typeof setTimeout> | null = null;
const diagWaiters = new Map<string, (diags: any[]) => void>();

/** Reset module state between runs (for programmatic multi-run usage). */
export function resetState() {
  msgId = 0;
  serverDead = false;
  chunks.length = 0;
  chunksLen = 0;
  pending.clear();
  diagnosticsReceived.clear();
  lastInitMs = 0;
  inBrokenSequence = false;

  warnings.length = 0;
  allFilesWaitResolve = null;
  allFilesWaitReject = null;
  expectedDiagnosticUris.clear();
  if (outerTimer) { clearTimeout(outerTimer); outerTimer = null; }
  diagWaiters.clear();
  vscodeSettings = null;
}

function cleanupWaitTimers() {
  if (outerTimer) { clearTimeout(outerTimer); outerTimer = null; }
}

function finishWait() {
  if (!allFilesWaitResolve) return;
  if (expectedDiagnosticUris.size > 0) return;
  const resolve = allFilesWaitResolve;
  allFilesWaitResolve = null;
  allFilesWaitReject = null;
  cleanupWaitTimers();
  resolve();
}

function failWait(error: Error) {
  if (!allFilesWaitReject) return;
  const reject = allFilesWaitReject;
  allFilesWaitResolve = null;
  allFilesWaitReject = null;
  cleanupWaitTimers();
  reject(error);
}

function onProjectInitialized() {
  const now = Date.now();

  if (lastInitMs > 0 && (now - lastInitMs) < 500) {
    if (!inBrokenSequence) {
      inBrokenSequence = true;
      warnings.push(
        "A CSS file failed to initialize (likely an @apply referencing an unknown utility). " +
        "That project's files will not receive diagnostics. " +
        "See https://github.com/tailwindlabs/tailwindcss-intellisense/issues/1121",
      );
    }
  } else {
    inBrokenSequence = false;
  }

  lastInitMs = now;
}

export function waitForAllFiles(
  expectedUris: Iterable<string>,
  timeoutMs?: number,
): Promise<void> {
  if (serverDead) {
    return Promise.reject(new Error("language server is not running"));
  }

  expectedDiagnosticUris.clear();
  for (const uri of expectedUris) {
    if (!diagnosticsReceived.has(uri)) {
      expectedDiagnosticUris.add(uri);
    }
  }

  if (expectedDiagnosticUris.size === 0) return Promise.resolve();

  return new Promise((res, rej) => {
    allFilesWaitResolve = res;
    allFilesWaitReject = rej;

    const fileWaitMs = expectedDiagnosticUris.size * 500;
    const outerMs = timeoutMs ?? Math.min(Math.max(fileWaitMs, 30_000), 120_000);
    outerTimer = setTimeout(() => {
      failWait(
        new Error(
          `timed out waiting for diagnostics from ${expectedDiagnosticUris.size} files`,
        ),
      );
    }, outerMs);
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

    processMessage(msg);
  }
}

function processMessage(msg: any) {
  if (DEBUG) console.error(`<- ${msg.method || `response#${msg.id}`}`);

  if (msg.id != null && !msg.method && pending.has(msg.id)) {
    const p = pending.get(msg.id)!;
    pending.delete(msg.id);
    if (msg.error) p.reject(msg.error);
    else p.resolve(msg.result);
    return;
  }

  if (msg.id != null && msg.method) {
    let result: any = null;
    if (msg.method === "workspace/configuration") {
      result = (msg.params?.items || []).map((item: any) =>
        item.section ? getSettingsSection(item.section) : {},
      );
    }
    writeMessage({ jsonrpc: "2.0", id: msg.id, result });
    return;
  }

  if (msg.method === "textDocument/publishDiagnostics" && msg.params) {
    const uri = normUri(msg.params.uri);
    const diags = msg.params.diagnostics || [];
    diagnosticsReceived.set(uri, diags);
    expectedDiagnosticUris.delete(uri);

    if (diagWaiters.has(uri)) {
      const resolve = diagWaiters.get(uri)!;
      diagWaiters.delete(uri);
      resolve(diags);
    }

    finishWait();
  }

  if (msg.method === "@/tailwindCSS/projectInitialized") {
    onProjectInitialized();
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

function findLanguageServer(cwd: string): [string, boolean] {
  const js = resolve(cwd, "node_modules/@tailwindcss/language-server/bin/tailwindcss-language-server");
  return existsSync(js) ? [js, true] : ["tailwindcss-language-server", false];
}

/** Reject all pending requests and resolve all waiters. Called when the server dies. */
function drainAll(reason: Error) {
  serverDead = true;
  for (const p of pending.values()) p.reject(reason);
  pending.clear();
  failWait(reason);
  for (const r of diagWaiters.values()) r([]);
  diagWaiters.clear();
}

export function startServer(root: string) {
  workspaceRoot = root;
  const [bin, ipc] = findLanguageServer(root);
  server = ipc
    ? spawn(process.execPath, [bin, "--node-ipc"], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      })
    : spawn(bin, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"] });

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

  if (ipc) {
    server.on("message", processMessage);
  } else {
    server.stdout!.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      chunksLen += chunk.length;
      processMessages();
    });
  }

  server.stderr?.on("data", (chunk: Buffer) => {
    if (DEBUG) process.stderr.write(chunk);
  });
}

function writeMessage(message: object) {
  if (server.connected) {
    server.send(message);
    return;
  }

  server.stdin!.write(encode(message));
}

export function send(method: string, params: object): Promise<any> {
  if (serverDead) return Promise.reject(new Error("language server is not running"));
  const id = ++msgId;
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    try {
      writeMessage({ jsonrpc: "2.0", id, method, params });
    } catch {
      pending.delete(id);
      rej(new Error("language server is not running"));
    }
  });
}

export function notify(method: string, params: object) {
  if (serverDead) return;
  try {
    writeMessage({ jsonrpc: "2.0", method, params });
  } catch {
    // Server pipe is dead — drainAll will handle cleanup via the close event
  }
}

export async function shutdown() {
  if (serverDead) return;
  await Promise.race([
    send("shutdown", {}).catch(() => {}),
    new Promise(r => setTimeout(r, 500)),
  ]);
  notify("exit", {});
  serverDead = true;
  try { server.disconnect(); } catch {}
  try { server.stdin!.end(); } catch {}
  try { server.stdout?.destroy(); } catch {}
  try { server.stderr?.destroy(); } catch {}
  server.kill();
}

export function fileUri(absPath: string): string {
  return normUri(pathToFileURL(absPath).href);
}

/** Decoded, lowercase-drive canonical form so our URIs and the server's compare equal on Windows. */
export function normUri(uri: string): string {
  return decodeURIComponent(uri).replace(/^file:\/\/\/(\w):/, (_, d) => `file:///${d.toLowerCase()}:`);
}

export function langId(filePath: string): string {
  if (filePath.endsWith(".css")) return "css";
  if (filePath.endsWith(".html") || filePath.endsWith(".vue") || filePath.endsWith(".svelte") || filePath.endsWith(".astro")) return "html";
  if (filePath.endsWith(".mdx")) return "mdx";
  if (filePath.endsWith(".jsx")) return "javascriptreact";
  return "typescriptreact";
}
