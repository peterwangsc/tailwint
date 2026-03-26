/**
 * tailwint — Tailwind CSS linter powered by the official language server.
 *
 * Spawns @tailwindcss/language-server over stdio, feeds it your files,
 * and collects the same diagnostics VS Code shows. Supports --fix via
 * LSP code actions. Works with Tailwind CSS v4.
 */

import { spawn, type ChildProcess } from "child_process";
import { resolve, relative } from "path";
import { readFileSync, writeFileSync } from "fs";
import { glob } from "glob";

const DEFAULT_PATTERNS = ["**/*.{tsx,jsx,html,vue,svelte}"];
const DEBUG = process.env.DEBUG === "1";

// ---------------------------------------------------------------------------
// LSP JSON-RPC over stdio
// ---------------------------------------------------------------------------

let msgId = 0;

function encode(obj: object): string {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function makeRequest(method: string, params: object) {
  return { encoded: encode({ jsonrpc: "2.0", id: ++msgId, method, params }), id: msgId };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: ChildProcess;
let rawBuf = Buffer.alloc(0);
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
const diagnosticsReceived = new Map<string, any[]>();

function findLanguageServer(cwd: string): string {
  // Look for the binary in the project's node_modules first, then fall back to global
  const local = resolve(cwd, "node_modules/.bin/tailwindcss-language-server");
  try {
    readFileSync(local);
    return local;
  } catch {
    return "tailwindcss-language-server";
  }
}

function startServer(cwd: string) {
  const bin = findLanguageServer(cwd);
  server = spawn(bin, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"] });

  server.stdout!.on("data", (chunk: Buffer) => {
    rawBuf = Buffer.concat([rawBuf, chunk]);
    processMessages();
  });

  server.stderr!.on("data", (chunk: Buffer) => {
    if (DEBUG) process.stderr.write(chunk);
  });
}

function processMessages() {
  while (true) {
    const str = rawBuf.toString("ascii");
    const headerEnd = str.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const headerBlock = str.slice(0, headerEnd);
    const clMatch = headerBlock.match(/Content-Length:\s*(\d+)/i);
    if (!clMatch) {
      rawBuf = rawBuf.subarray(headerEnd + 4);
      continue;
    }

    const len = parseInt(clMatch[1], 10);
    const bodyStart = headerEnd + 4;
    if (rawBuf.length < bodyStart + len) break;

    const body = rawBuf.subarray(bodyStart, bodyStart + len).toString("utf-8");
    rawBuf = rawBuf.subarray(bodyStart + len);

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
      diagnosticsReceived.set(msg.params.uri, msg.params.diagnostics || []);
    }
  }
}

function send(method: string, params: object): Promise<any> {
  const { encoded, id } = makeRequest(method, params);
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    server.stdin!.write(encoded);
  });
}

function notify(method: string, params: object) {
  server.stdin!.write(encode({ jsonrpc: "2.0", method, params }));
}

function fileUri(absPath: string): string {
  return `file://${absPath}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function langId(filePath: string): string {
  if (filePath.endsWith(".css")) return "css";
  if (filePath.endsWith(".html") || filePath.endsWith(".vue") || filePath.endsWith(".svelte")) return "html";
  if (filePath.endsWith(".jsx")) return "javascriptreact";
  return "typescriptreact";
}

// ---------------------------------------------------------------------------
// Fix: apply code actions from the LSP
// ---------------------------------------------------------------------------

interface TextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

function applyEdits(content: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => {
    const lineDiff = b.range.start.line - a.range.start.line;
    return lineDiff !== 0 ? lineDiff : b.range.start.character - a.range.start.character;
  });

  const lines = content.split("\n");

  for (const edit of sorted) {
    const { start, end } = edit.range;
    const before = lines.slice(0, start.line);
    const startLine = lines[start.line] || "";
    const endLine = lines[end.line] || "";
    const prefix = startLine.slice(0, start.character);
    const suffix = endLine.slice(end.character);
    const middle = prefix + edit.newText + suffix;
    const after = lines.slice(end.line + 1);
    lines.length = 0;
    lines.push(...before, ...middle.split("\n"), ...after);
  }

  return lines.join("\n");
}

async function waitForFreshDiagnostics(uri: string): Promise<any[]> {
  diagnosticsReceived.delete(uri);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(200);
    if (diagnosticsReceived.has(uri)) return diagnosticsReceived.get(uri)!;
  }
  return [];
}

async function fixFile(
  filePath: string,
  initialDiags: any[],
  fileContents: Map<string, string>,
  version: Map<string, number>,
): Promise<number> {
  const uri = fileUri(filePath);
  let content = fileContents.get(filePath)!;
  let ver = version.get(filePath)!;
  let fixCount = 0;
  let diags = initialDiags;
  const maxPasses = 20;

  for (let pass = 0; pass < maxPasses && diags.length > 0; pass++) {
    const diag = diags[0];

    const actions = await send("textDocument/codeAction", {
      textDocument: { uri },
      range: diag.range,
      context: { diagnostics: [diag], only: ["quickfix"] },
    });

    if (!actions || actions.length === 0) {
      diags = diags.slice(1);
      continue;
    }

    const action = actions[0];
    const edits: TextEdit[] = action.edit?.changes?.[uri] || action.edit?.documentChanges?.[0]?.edits || [];
    if (edits.length === 0) {
      diags = diags.slice(1);
      continue;
    }

    content = applyEdits(content, edits);
    fixCount++;

    ver++;
    notify("textDocument/didChange", {
      textDocument: { uri, version: ver },
      contentChanges: [{ text: content }],
    });

    diags = (await waitForFreshDiagnostics(uri)).filter(
      (d: any) => d.severity === 1 || d.severity === 2,
    );
  }

  if (fixCount > 0) {
    writeFileSync(filePath, content);
    fileContents.set(filePath, content);
    version.set(filePath, ver);
  }

  return fixCount;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TailwintOptions {
  /** File glob patterns to check. Defaults to **\/*.{tsx,jsx,html,vue,svelte} */
  patterns?: string[];
  /** Auto-fix issues using LSP code actions */
  fix?: boolean;
  /** Working directory. Defaults to process.cwd() */
  cwd?: string;
}

/**
 * Run the Tailwind CSS linter.
 * Returns 0 if no issues found (or all fixed), 1 if issues remain.
 */
export async function run(options: TailwintOptions = {}): Promise<number> {
  const cwd = resolve(options.cwd || process.cwd());
  const fix = options.fix ?? false;
  const patterns = options.patterns ?? DEFAULT_PATTERNS;

  const files: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, { cwd, absolute: true, nodir: true });
    files.push(...matches);
  }

  if (files.length === 0) {
    console.log("No files matched.");
    return 0;
  }

  console.error(`Checking ${files.length} file(s)...`);

  // Start server and initialize
  startServer(cwd);

  await send("initialize", {
    processId: process.pid,
    rootUri: fileUri(cwd),
    capabilities: {
      textDocument: {
        publishDiagnostics: { relatedInformation: true },
        codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix"] } } },
      },
      workspace: { workspaceFolders: true, configuration: true },
    },
    workspaceFolders: [{ uri: fileUri(cwd), name: "workspace" }],
  });

  notify("initialized", {});
  await sleep(3000);

  // Open all files
  const fileContents = new Map<string, string>();
  const fileVersions = new Map<string, number>();

  for (const filePath of files) {
    const content = readFileSync(filePath, "utf-8");
    fileContents.set(filePath, content);
    fileVersions.set(filePath, 1);

    notify("textDocument/didOpen", {
      textDocument: { uri: fileUri(filePath), languageId: langId(filePath), version: 1, text: content },
    });
  }

  // Wait for diagnostics
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await sleep(500);
    const received = files.filter((f) => diagnosticsReceived.has(fileUri(f))).length;
    if (received >= files.length) break;
  }

  // Collect issues
  let totalIssues = 0;
  const issuesByFile = new Map<string, any[]>();

  for (const filePath of files) {
    const diags = diagnosticsReceived.get(fileUri(filePath)) || [];
    const meaningful = diags.filter((d: any) => d.severity === 1 || d.severity === 2);
    if (meaningful.length > 0) {
      issuesByFile.set(filePath, meaningful);
      totalIssues += meaningful.length;
    }
  }

  if (totalIssues === 0) {
    console.log(`\u2713 ${files.length} file(s) checked, no Tailwind issues found.`);
    await shutdown();
    return 0;
  }

  // Report
  for (const [filePath, diags] of issuesByFile) {
    const rel = relative(cwd, filePath);
    for (const d of diags) {
      const line = (d.range?.start?.line ?? 0) + 1;
      const col = (d.range?.start?.character ?? 0) + 1;
      const severity = d.severity === 1 ? "error" : "warning";
      const code = d.code ? ` (${d.code})` : "";
      console.log(`${rel}:${line}:${col}: ${severity}: ${d.message}${code}`);
    }
  }

  // Fix mode
  if (fix) {
    let totalFixed = 0;
    for (const [filePath, diags] of issuesByFile) {
      const fixed = await fixFile(filePath, diags, fileContents, fileVersions);
      totalFixed += fixed;
    }
    console.log(`\n\u2713 Fixed ${totalFixed} of ${totalIssues} issue(s)`);
    await shutdown();
    return 0;
  }

  console.log(`\n\u2717 ${totalIssues} issue(s) in ${issuesByFile.size} file(s)`);
  console.log(`  Run with --fix to auto-fix`);
  await shutdown();
  return 1;
}

async function shutdown() {
  await send("shutdown", {}).catch(() => {});
  notify("exit", {});
  server.kill();
}
