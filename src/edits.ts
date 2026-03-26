/**
 * Text edit application and fix orchestration.
 */

import { writeFileSync } from "fs";
import { send, notify, fileUri, waitForDiagnostic } from "./lsp.js";

export interface TextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  newText: string;
}

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

function rangeKey(range: TextEdit["range"]): string {
  return `${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function posLte(a: { line: number; character: number }, b: { line: number; character: number }): boolean {
  return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

function rangeContains(outer: TextEdit, inner: TextEdit): boolean {
  return posLte(outer.range.start, inner.range.start) && posLte(inner.range.end, outer.range.end);
}

function filterContainedEdits(edits: TextEdit[]): TextEdit[] {
  const result: TextEdit[] = [];
  for (const edit of edits) {
    const containedByAnother = edits.some(
      (other) => other !== edit && rangeContains(other, edit),
    );
    if (!containedByAnother) result.push(edit);
  }
  return result;
}

async function waitForFreshDiagnostics(uri: string): Promise<any[]> {
  return waitForDiagnostic(uri);
}

export async function fixFile(
  filePath: string,
  initialDiags: any[],
  fileContents: Map<string, string>,
  version: Map<string, number>,
  onPass?: (pass: number) => void,
): Promise<number> {
  const DEBUG = process.env.DEBUG === "1";
  const uri = fileUri(filePath);
  let content = fileContents.get(filePath)!;
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
        }).catch(() => null),
      ),
    );

    const editsByRange = new Map<string, TextEdit>();
    for (let i = 0; i < diags.length; i++) {
      const actions = actionResults[i];
      if (!actions || actions.length === 0) continue;

      const action = actions[0];
      const edits: TextEdit[] =
        action.edit?.changes?.[uri] || action.edit?.documentChanges?.[0]?.edits || [];
      if (edits.length === 0) continue;

      for (const e of edits) {
        const key = rangeKey(e.range);
        editsByRange.set(key, e);
      }
    }

    let candidates = [...editsByRange.values()];
    if (candidates.length === 0) break;

    candidates = filterContainedEdits(candidates);

    const prev = content;
    content = applyEdits(content, candidates);
    if (content === prev) break;

    ver++;
    notify("textDocument/didChange", {
      textDocument: { uri, version: ver },
      contentChanges: [{ text: content }],
    });

    diags = (await waitForFreshDiagnostics(uri)).filter(
      (d: any) => d.severity === 1 || d.severity === 2,
    );
  }

  if (content !== fileContents.get(filePath)) {
    writeFileSync(filePath, content);
    fileContents.set(filePath, content);
    version.set(filePath, ver);
  }

  return issueCount;
}
