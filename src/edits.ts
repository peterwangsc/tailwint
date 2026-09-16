/**
 * Text edit application and fix orchestration.
 */

import { readFileSync, writeFileSync } from "fs";
import { send, notify, fileUri, normUri, waitForDiagnostic } from "./lsp.js";

export interface TextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

type OffsetEdit = { start: number; end: number; newText: string };

export function applyEdits(content: string, edits: TextEdit[]): string {
  if (edits.length === 0) return content;

  const lineOffsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") lineOffsets.push(i + 1);
  }

  function toOffset(line: number, char: number): number {
    if (line >= lineOffsets.length) return content.length;
    return Math.min(lineOffsets[line] + char, content.length);
  }

  const absolute = edits.map((e) => ({
    start: toOffset(e.range.start.line, e.range.start.character),
    end: toOffset(e.range.end.line, e.range.end.character),
    newText: e.newText,
  }));

  return applyOffsetEdits(content, absolute);
}

function applyOffsetEdits(content: string, absolute: OffsetEdit[]): string {
  absolute.sort((a, b) => a.start - b.start);

  const parts: string[] = [];
  let cursor = 0;
  for (const e of absolute) {
    if (e.start > cursor) parts.push(content.slice(cursor, e.start));
    parts.push(e.newText);
    cursor = e.end;
  }
  if (cursor < content.length) parts.push(content.slice(cursor));

  return parts.join("");
}

/** Autofix accepts only complete actions that can be applied to this document. */
function documentEdits(action: any, uri: string, version: number): TextEdit[] {
  if (!action?.edit || action.disabled || action.command) return [];
  const edit = action.edit;
  if (edit.documentChanges !== undefined) {
    if (!Array.isArray(edit.documentChanges) || edit.documentChanges.length !== 1) return [];
    const change = edit.documentChanges[0];
    if (!change?.textDocument || change.kind || normUri(change.textDocument.uri) !== uri) return [];
    if (change.textDocument.version != null && change.textDocument.version !== version) {
      throw new Error("Stale document version in autofix edit");
    }
    return change.edits;
  }
  const changes = edit.changes || {};
  const keys = Object.keys(changes);
  return keys.length === 1 && normUri(keys[0]) === uri ? changes[keys[0]] : [];
}

/** Validate server edits before they can reach didChange or the filesystem. */
function validatedEdits(content: string, edits: TextEdit[]): OffsetEdit[] {
  if (!Array.isArray(edits)) throw new Error("Invalid autofix edits");
  const lines = content.split(/\r\n|\r|\n/);
  const offsets = [0];
  for (const match of content.matchAll(/\r\n|\r|\n/g)) offsets.push(match.index! + match[0].length);
  function offset(position: TextEdit["range"]["start"]): number {
    if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character)
      || position.line < 0 || position.line >= lines.length || position.character < 0) {
      throw new Error("Invalid position in autofix edit");
    }
    // LSP columns beyond the line clamp to its end, not to the document's end.
    return offsets[position.line] + Math.min(position.character, lines[position.line].length);
  }
  const absolute = edits.map(edit => {
    if (!edit?.range || typeof edit.newText !== "string") throw new Error("Invalid autofix edit");
    const start = offset(edit.range.start), end = offset(edit.range.end);
    if (end < start) throw new Error("Reversed range in autofix edit");
    return { start, end, newText: edit.newText };
  }).sort((a, b) => a.start - b.start);
  let end = 0;
  for (const edit of absolute) {
    if (edit.start < end) throw new Error("Overlapping ranges within an autofix action");
    end = edit.end;
  }
  return absolute;
}

function overlaps(a: OffsetEdit, b: OffsetEdit): boolean {
  if (a.start === a.end) return a.start >= b.start && a.start <= b.end;
  if (b.start === b.end) return b.start >= a.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

/** Defer conflicting actions whole; their diagnostics will be requested again. */
function compatibleEdits(batches: OffsetEdit[][]): OffsetEdit[] {
  const size = (batch: OffsetEdit[]) => batch.reduce((sum, edit) => sum + edit.end - edit.start, 0);
  // Keep the existing preference for broad conflict fixes and later alternatives.
  batches.reverse().sort((a, b) => size(b) - size(a));
  const selected: OffsetEdit[] = [];
  for (const batch of batches) {
    if (!batch.some(edit => selected.some(other => overlaps(edit, other)))) selected.push(...batch);
  }
  return selected;
}

export interface FixResult {
  initial: number;
  remaining: number;
}

export async function fixFile(
  filePath: string,
  initialDiags: any[],
  fileContents: Map<string, string>,
  version: Map<string, number>,
  onPass?: (pass: number) => void,
  timeoutMs = 30_000,
): Promise<FixResult> {
  const DEBUG = process.env.DEBUG === "1";
  const uri = fileUri(filePath);
  let content = fileContents.get(filePath)!;
  const originalContent = content;
  const seenTransitions = new Set<string>();
  let ver = version.get(filePath)!;
  const issueCount = initialDiags.length;
  let diags = initialDiags;
  for (let pass = 0; diags.length > 0; pass++) {
    onPass?.(pass + 1);
    if (DEBUG) console.error(`    pass ${pass + 1}: ${diags.length} remaining`);

    const actionResults = await Promise.all(
      diags.map((diag) =>
        send("textDocument/codeAction", {
          textDocument: { uri },
          range: diag.range,
          context: { diagnostics: [diag], only: ["quickfix"] },
        }, timeoutMs),
      ),
    );

    const batches: OffsetEdit[][] = [];
    for (let i = 0; i < diags.length; i++) {
      const actions = actionResults[i];
      if (!actions || actions.length === 0) continue;

      for (const action of actions) {
        const edits = validatedEdits(content, documentEdits(action, uri, ver));
        if (edits.length === 0) continue;
        if (applyOffsetEdits(content, edits) === content) continue;
        batches.push(edits);
        break;
      }
    }

    const candidates = compatibleEdits(batches);
    if (candidates.length === 0) break;

    // Repeated text alone is not a cycle if the server proposes a different fix.
    const transition = JSON.stringify([content, candidates]);
    if (seenTransitions.has(transition)) throw new Error(`Autofix cycle detected for ${filePath}; file left unchanged.`);
    seenTransitions.add(transition);
    const next = applyOffsetEdits(content, candidates);
    if (next === content) break;
    content = next;

    ver++;
    const nextDiagnostics = waitForDiagnostic(uri, timeoutMs);
    notify("textDocument/didChange", {
      textDocument: { uri, version: ver },
      contentChanges: [{ text: content }],
    });

    diags = (await nextDiagnostics).filter(
      (d: any) => d.severity === 1 || d.severity === 2,
    );
  }

  if (content !== originalContent) {
    if (readFileSync(filePath, "utf8") !== originalContent) {
      throw new Error(`File changed on disk during autofix: ${filePath}; refusing to overwrite it.`);
    }
    writeFileSync(filePath, content);
    fileContents.set(filePath, content);
    version.set(filePath, ver);
  }

  return { initial: issueCount, remaining: diags.length };
}
