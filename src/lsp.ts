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
// Project-aware wait state
// ---------------------------------------------------------------------------

/** Tracking for projectInitialized events */
export let projectInitCount = 0;
export let settledProjects = 0;
export let brokenProjects = 0;
let lastInitMs = 0;
let inBrokenSequence = false;
let awaitingFirstDiag = false;
let currentProjectDiagCount = 0;
export const warnings: string[] = [];

/** Internal waiter state */
let projectWaitResolve: (() => void) | null = null;
let diagDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let projectInitTimer: ReturnType<typeof setTimeout> | null = null;
let outerTimer: ReturnType<typeof setTimeout> | null = null;
const diagWaiters = new Map<string, (diags: any[]) => void>();

/** Config for the current wait */
let waitConfig = { predictedRoots: 0, maxProjects: 0, initTimeoutMs: 5000, debounceMs: 500 };

/** Reset module state between runs (for programmatic multi-run usage). */
export function resetState() {
  msgId = 0;
  serverDead = false;
  chunks.length = 0;
  chunksLen = 0;
  pending.clear();
  diagnosticsReceived.clear();
  projectReady = false;
  projectInitCount = 0;
  settledProjects = 0;
  brokenProjects = 0;
  lastInitMs = 0;
  inBrokenSequence = false;
  awaitingFirstDiag = false;
  currentProjectDiagCount = 0;
  warnings.length = 0;
  projectWaitResolve = null;
  if (diagDebounceTimer) { clearTimeout(diagDebounceTimer); diagDebounceTimer = null; }
  if (projectInitTimer) { clearTimeout(projectInitTimer); projectInitTimer = null; }
  if (outerTimer) { clearTimeout(outerTimer); outerTimer = null; }
  diagWaiters.clear();
  vscodeSettings = null;
}

function cleanupWaitTimers() {
  if (diagDebounceTimer) { clearTimeout(diagDebounceTimer); diagDebounceTimer = null; }
  if (projectInitTimer) { clearTimeout(projectInitTimer); projectInitTimer = null; }
  if (outerTimer) { clearTimeout(outerTimer); outerTimer = null; }
}

function finishWait() {
  if (!projectWaitResolve) return;
  const resolve = projectWaitResolve;
  projectWaitResolve = null;
  cleanupWaitTimers();
  resolve();
}

function isAllResolved(): boolean {
  const resolved = settledProjects + brokenProjects;
  return resolved >= waitConfig.maxProjects;
}

function startProjectInitTimeout() {
  if (projectInitTimer) clearTimeout(projectInitTimer);
  projectInitTimer = setTimeout(() => {
    // Timer fired — either no project init came, or we were waiting for
    // more diagnostics after a single early one. If we got any diagnostics
    // for the current project, settle it before finishing.
    if (currentProjectDiagCount > 0 && !awaitingFirstDiag) {
      settleCurrentProject();
    } else {
      finishWait();
    }
  }, waitConfig.initTimeoutMs);
}

function onProjectInitialized() {
  projectInitCount++;
  const now = Date.now();
  projectReady = true;

  if (lastInitMs > 0 && (now - lastInitMs) < 500) {
    // Rapid re-init — broken project
    if (!inBrokenSequence) {
      // First rapid init after a healthy one — the previous healthy init was actually broken
      inBrokenSequence = true;
      brokenProjects++;
      warnings.push(
        "A CSS file failed to initialize (likely an @apply referencing an unknown utility). " +
        "That project's files will not receive diagnostics. " +
        "See https://github.com/tailwindlabs/tailwindcss-intellisense/issues/1121",
      );
      // The previous init was counted as starting a healthy project's diagnostic wait.
      // Cancel that wait — this project won't produce diagnostics.
      if (diagDebounceTimer) { clearTimeout(diagDebounceTimer); diagDebounceTimer = null; }
    }
    // Additional rapid inits for the same broken project — just update timestamp
  } else {
    // Healthy init — new project starting
    inBrokenSequence = false;
    awaitingFirstDiag = true;
    currentProjectDiagCount = 0;
    // Cancel any pending project-init timeout since we just got a new one
    if (projectInitTimer) { clearTimeout(projectInitTimer); projectInitTimer = null; }
    if (diagDebounceTimer) { clearTimeout(diagDebounceTimer); diagDebounceTimer = null; }
    // Don't start the diagnostic debounce yet — wait for the first diagnostic to arrive.
    // Use the init timeout as the safety net (if no diagnostics arrive at all,
    // this project is effectively broken even though it didn't rapid-fire).
    startProjectInitTimeout();
  }

  lastInitMs = now;

  // Check if broken projects pushed us to completion
  if (isAllResolved()) {
    finishWait();
  }
}

function settleCurrentProject() {
  settledProjects++;
  if (isAllResolved()) {
    finishWait();
  } else {
    startProjectInitTimeout();
  }
}

function startDiagDebounce() {
  if (diagDebounceTimer) clearTimeout(diagDebounceTimer);
  // Cancel the init timeout — we're now in diagnostic-settling mode
  if (projectInitTimer) { clearTimeout(projectInitTimer); projectInitTimer = null; }
  diagDebounceTimer = setTimeout(settleCurrentProject, waitConfig.debounceMs);
}

function onDiagnosticReceived() {
  if (!projectWaitResolve) return;
  currentProjectDiagCount++;

  if (awaitingFirstDiag) {
    // First diagnostic after a healthy init — don't start the debounce yet.
    // The first diagnostic is often just the CSS entry point, followed by a
    // ~1s pause before the bulk TSX diagnostics arrive. Starting the debounce
    // here would settle too early on large projects.
    awaitingFirstDiag = false;
  } else if (currentProjectDiagCount >= 2) {
    // Second diagnostic and beyond — the bulk is flowing, debounce is safe
    startDiagDebounce();
  }
}

/**
 * Wait for all expected projects to be resolved (settled or broken).
 *
 * @param predictedRoots - Number of CSS files predicted to be project roots
 * @param maxProjects - Upper bound (predictedRoots + predictedNonRoots)
 * @param initTimeoutMs - How long to wait for each projectInitialized event
 * @param debounceMs - Silence window to consider diagnostics "settled"
 */
export function waitForAllProjects(
  predictedRoots: number,
  maxProjects: number,
  initTimeoutMs = 5_000,
  debounceMs = 500,
): Promise<void> {
  if (serverDead || maxProjects === 0) return Promise.resolve();

  waitConfig = { predictedRoots, maxProjects, initTimeoutMs, debounceMs };

  return new Promise((res) => {
    projectWaitResolve = res;

    // Start waiting for first project init
    startProjectInitTimeout();

    // Hard outer timeout — never wait longer than this
    const outerMs = initTimeoutMs + (maxProjects * 3000) + 5000;
    outerTimer = setTimeout(finishWait, Math.min(outerMs, 30_000));
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

      // Notify the project-aware wait system
      onDiagnosticReceived();
    }

    // Tailwind project initialized
    if (msg.method === "@/tailwindCSS/projectInitialized") {
      onProjectInitialized();
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
  for (const p of pending.values()) p.reject(reason);
  pending.clear();
  finishWait();
  for (const r of diagWaiters.values()) r([]);
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
  await Promise.race([
    send("shutdown", {}).catch(() => {}),
    new Promise(r => setTimeout(r, 500)),
  ]);
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
