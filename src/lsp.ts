/**
 * LSP client — spawns tailwindcss-language-server over stdio and speaks JSON-RPC.
 */

import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";
import { pathToFileURL, fileURLToPath } from "url";
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

let server: ChildProcess | undefined;
let serverDead = false;
let serverStopping = false;
let msgId = 0;

const chunks: Buffer[] = [];
let chunksLen = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();

export const diagnosticsReceived = new Map<string, any[]>();
const diagWaiters = new Map<string, { resolve: (diags: any[]) => void; reject: (error: Error) => void }>();

/** Reset module state between sequential programmatic runs. */
export function resetState() {
  msgId = 0;
  serverDead = false;
  serverStopping = false;
  chunks.length = 0;
  chunksLen = 0;
  pending.clear();
  diagnosticsReceived.clear();
  diagWaiters.clear();
  vscodeSettings = null;
}

/**
 * Tailwind's hover handler awaits workspace initialization. Project notifications
 * and silence between diagnostics do not guarantee that initialization is done.
 * Once the request completes, ask the server which files have an enabled project
 * and wait for their individual publications, including empty diagnostic lists.
 */
export async function waitForDiagnostics(uris: string[], timeoutMs = 30_000): Promise<void> {
  if (uris.length === 0) return;
  await send("textDocument/hover", {
    textDocument: { uri: uris[0] }, position: { line: 0, character: 0 },
  }, timeoutMs);

  await Promise.all(uris.map(async (uri) => {
    const project = await send("@/tailwindCSS/getProject", { uri }, timeoutMs);
    if (!project) {
      throw new Error(`No initialized Tailwind project for ${uri}. Check the Tailwind configuration and DEBUG=1 output; scan is incomplete.`);
    }
    // Publications may arrive while the initialization request is in flight.
    if (!diagnosticsReceived.has(normUri(uri))) {
      await waitForDiagnostic(uri, timeoutMs);
    }
  }));
}

/** Wait for a fresh publication; a timeout or server failure is never "clean". */
export function waitForDiagnostic(uri: string, timeoutMs = 30_000): Promise<any[]> {
  if (serverDead || !server) return Promise.reject(new Error("language server is not running"));
  uri = normUri(uri);
  diagnosticsReceived.delete(uri);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      diagWaiters.delete(uri);
      reject(new Error(`Timed out waiting for diagnostics for ${uri}; scan is incomplete.`));
    }, timeoutMs);
    diagWaiters.set(uri, {
      resolve: (diags) => { clearTimeout(timer); resolve(diags); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
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

    if (DEBUG) {
      console.error(`<- ${msg.method || `response#${msg.id}`}`);
      if (msg.method === "window/logMessage" || msg.method === "window/showMessage") {
        console.error(msg.params?.message);
      }
    }

    // Response to our request
    if (msg.id != null && !msg.method && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || "Language server request failed"));
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
      server?.stdin!.write(encode({ jsonrpc: "2.0", id: msg.id, result }));
      continue;
    }

    // Published diagnostics
    if (msg.method === "textDocument/publishDiagnostics" && msg.params && !serverStopping) {
      const uri = normUri(msg.params.uri);
      const diags = msg.params.diagnostics || [];
      diagnosticsReceived.set(uri, diags);

      // Resolve URI-specific waiter
      if (diagWaiters.has(uri)) {
        const waiter = diagWaiters.get(uri)!;
        diagWaiters.delete(uri);
        waiter.resolve(diags);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

function findLanguageServer(cwd: string): string[] {
  const js = resolve(cwd, "node_modules/@tailwindcss/language-server/bin/tailwindcss-language-server");
  return existsSync(js) ? [process.execPath, js] : ["tailwindcss-language-server"];
}

/** Reject pending work when the server dies or shuts down. */
function drainAll(reason: Error) {
  serverDead = true;
  for (const p of pending.values()) p.reject(reason);
  pending.clear();
  for (const waiter of diagWaiters.values()) waiter.reject(reason);
  diagWaiters.clear();
}

export function startServer(root: string) {
  workspaceRoot = root;
  const [bin, ...args] = findLanguageServer(root);
  const child = server = spawn(bin, [...args, "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  // A previous run's close event may arrive after the next run has started.
  const fail = (error: Error) => { if (server === child) drainAll(error); };
  child.stdin!.on("error", fail);

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      console.error("\n  \x1b[38;5;203m\x1b[1mERROR\x1b[0m @tailwindcss/language-server not found.");
      console.error("  Install it: \x1b[1mnpm install -D @tailwindcss/language-server\x1b[0m\n");
    }
    fail(new Error(err.code === "ENOENT"
      ? "@tailwindcss/language-server not found"
      : `language server error: ${err.message}`));
  });

  server.on("close", (code, signal) => {
    if (server === child && !serverDead) {
      fail(new Error(
        signal ? `language server killed by ${signal}` : `language server exited with code ${code}`,
      ));
    }
  });

  server.stdout!.on("data", (chunk: Buffer) => {
    if (server !== child) return;
    chunks.push(chunk);
    chunksLen += chunk.length;
    processMessages();
  });

  server.stderr!.on("data", (chunk: Buffer) => {
    if (DEBUG) process.stderr.write(chunk);
  });
}

export function send(method: string, params: object, timeoutMs = 30_000): Promise<any> {
  if (serverDead || !server) return Promise.reject(new Error("language server is not running"));
  const child = server;
  const id = ++msgId;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error(`Timed out waiting for ${method}; scan is incomplete.`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); res(value); },
      reject: (error) => { clearTimeout(timer); rej(error); },
    });
    try {
      child.stdin!.write(encode({ jsonrpc: "2.0", id, method, params }));
    } catch {
      pending.get(id)!.reject(new Error("language server is not running"));
      pending.delete(id);
    }
  });
}

export function notify(method: string, params: object) {
  if (serverDead || !server) return;
  try {
    server.stdin!.write(encode({ jsonrpc: "2.0", method, params }));
  } catch {
    // Server pipe is dead — drainAll will handle cleanup via the close event
  }
}

export async function shutdown() {
  if (!server) return;
  const child = server;
  serverStopping = true;
  if (!serverDead) {
    await send("shutdown", {}, 500).catch(() => {});
    notify("exit", {});
  }
  drainAll(new Error("language server shut down"));
  child.stdin!.end();
  child.stdout!.destroy();
  child.stderr!.destroy();
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.kill();
      // A stuck server must not keep the CLI alive after the shutdown deadline.
      const timer = setTimeout(() => child.kill("SIGKILL"), 500);
      child.once("close", () => clearTimeout(timer));
    });
  }
  server = undefined;
}

export function fileUri(absPath: string): string {
  return normUri(pathToFileURL(absPath).href);
}

/** Keep reserved characters escaped while normalizing drive letters and URI encoding. */
export function normUri(uri: string): string {
  return pathToFileURL(fileURLToPath(uri)).href.replace(/^file:\/\/\/(\w):/, (_, d) => `file:///${d.toLowerCase()}:`);
}

export function langId(filePath: string): string {
  if (filePath.endsWith(".css")) return "css";
  if (filePath.endsWith(".html") || filePath.endsWith(".vue") || filePath.endsWith(".svelte") || filePath.endsWith(".astro")) return "html";
  if (filePath.endsWith(".mdx")) return "mdx";
  if (filePath.endsWith(".jsx")) return "javascriptreact";
  return "typescriptreact";
}
