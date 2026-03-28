/**
 * Tests for applyEdits from tailwint/edits.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { applyEdits, type TextEdit } from "../src/edits.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand to build a TextEdit */
function edit(
  startLine: number, startChar: number,
  endLine: number, endChar: number,
  newText: string,
): TextEdit {
  return {
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    },
    newText,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyEdits", () => {
  // ---- Basic operations ----

  it("returns content unchanged for empty edits array", () => {
    assert.equal(applyEdits("hello", []),"hello");
  });

  it("returns content unchanged for empty string input with no edits", () => {
    assert.equal(applyEdits("", []),"");
  });

  it("replaces a single word", () => {
    assert.equal(applyEdits("flex-shrink-0", [edit(0, 0, 0, 13, "shrink-0")]),"shrink-0");
  });

  it("inserts text at the beginning", () => {
    assert.equal(applyEdits("world", [edit(0, 0, 0, 0, "hello ")]),"hello world");
  });

  it("inserts text at the end", () => {
    assert.equal(applyEdits("hello", [edit(0, 5, 0, 5, " world")]),"hello world");
  });

  it("deletes text (empty newText)", () => {
    assert.equal(applyEdits("hello world", [edit(0, 5, 0, 11, "")]),"hello");
  });

  // ---- Multiple edits on the same line ----

  it("applies two non-overlapping edits on the same line", () => {
    const content = "z-[1] flex-shrink-0";
    const result = applyEdits(content, [
      edit(0, 0, 0, 5, "z-1"),
      edit(0, 6, 0, 19, "shrink-0"),
    ]);
    assert.equal(result,"z-1 shrink-0");
  });

  it("applies edits regardless of input order (unsorted)", () => {
    const content = "z-[1] flex-shrink-0";
    // Provide edits in reverse order — should still work
    const result = applyEdits(content, [
      edit(0, 6, 0, 19, "shrink-0"),
      edit(0, 0, 0, 5, "z-1"),
    ]);
    assert.equal(result,"z-1 shrink-0");
  });

  it("applies three edits on the same line", () => {
    const content = "z-[1] flex-shrink-0 min-w-[200px]";
    const result = applyEdits(content, [
      edit(0, 0, 0, 5, "z-1"),
      edit(0, 6, 0, 19, "shrink-0"),
      edit(0, 20, 0, 33, "min-w-50"),
    ]);
    assert.equal(result,"z-1 shrink-0 min-w-50");
  });

  // ---- Adjacent edits (shared boundary) ----

  it("handles adjacent edits that share a boundary", () => {
    const content = "aabbcc";
    const result = applyEdits(content, [
      edit(0, 0, 0, 2, "AA"),
      edit(0, 2, 0, 4, "BB"),
      edit(0, 4, 0, 6, "CC"),
    ]);
    assert.equal(result,"AABBCC");
  });

  it("handles adjacent insert-then-replace at same position", () => {
    // Two edits at position 0: first is a zero-width insert, second replaces chars 0-2
    // This is ambiguous — cursor advances past the first edit's end (0),
    // so the second edit at start=0 would have start < cursor after the first.
    // Current implementation: second edit's content replaces, but start <= cursor
    // means the slice between them is empty.
    const content = "abc";
    const result = applyEdits(content, [
      edit(0, 0, 0, 0, "X"),  // insert X at position 0
      edit(0, 0, 0, 1, "Y"),  // replace 'a' with Y
    ]);
    // Both edits start at offset 0. After sorting, they're in input order (stable sort?).
    // First edit: start=0, end=0 → inserts "X", cursor=0
    // Second edit: start=0 >= cursor(0), end=1 → but start is NOT > cursor, so no gap slice
    // Result: "X" + "Y" + "bc" = "XYbc"
    // This might be surprising — the "a" is deleted by the second edit but "X" is also inserted.
    // Let's just verify the actual behavior.
    assert.equal(result,"XYbc");
  });

  // ---- Multi-line edits ----

  it("replaces across multiple lines", () => {
    const content = "line1\nline2\nline3";
    const result = applyEdits(content, [
      edit(0, 3, 2, 3, "REPLACED"),
    ]);
    assert.equal(result,"linREPLACEDe3");
  });

  it("applies edits on different lines", () => {
    const content = "aaa\nbbb\nccc";
    const result = applyEdits(content, [
      edit(0, 0, 0, 3, "AAA"),
      edit(2, 0, 2, 3, "CCC"),
    ]);
    assert.equal(result,"AAA\nbbb\nCCC");
  });

  it("deletes an entire line including newline", () => {
    const content = "keep\ndelete\nkeep";
    const result = applyEdits(content, [
      edit(1, 0, 2, 0, ""),
    ]);
    assert.equal(result,"keep\nkeep");
  });

  it("inserts a new line", () => {
    const content = "line1\nline3";
    const result = applyEdits(content, [
      edit(1, 0, 1, 0, "line2\n"),
    ]);
    assert.equal(result,"line1\nline2\nline3");
  });

  // ---- Edge cases: out-of-bounds ----

  it("handles edit past end of file (line beyond last)", () => {
    const content = "hello";
    const result = applyEdits(content, [
      edit(5, 0, 5, 0, " world"),
    ]);
    // Line 5 doesn't exist — toOffset clamps to content.length
    assert.equal(result,"hello world");
  });

  it("handles edit with character past end of line", () => {
    const content = "hi";
    const result = applyEdits(content, [
      edit(0, 100, 0, 100, "!"),
    ]);
    // Character 100 on a 2-char line clamps to position 2
    assert.equal(result,"hi!");
  });

  // ---- Edge cases: empty content ----

  it("inserts into empty string", () => {
    assert.equal(applyEdits("", [edit(0, 0, 0, 0, "hello")]),"hello");
  });

  it("handles edit on empty string with out-of-bounds range", () => {
    assert.equal(applyEdits("", [edit(0, 0, 0, 10, "hello")]),"hello");
  });

  // ---- CRLF line endings ----

  it("handles CRLF line endings", () => {
    const content = "line1\r\nline2\r\nline3";
    // With CRLF, \r is a regular character — only \n triggers new line offset.
    // So line 1 starts after the \n at position 7 (l-i-n-e-1-\r-\n = 7 chars).
    // "line2" on line 1 starts at offset 7, char 0.
    const result = applyEdits(content, [
      edit(1, 0, 1, 5, "LINE2"),
    ]);
    assert.equal(result,"line1\r\nLINE2\r\nline3");
  });

  it("CRLF: replacing including \\r works correctly", () => {
    const content = "aa\r\nbb";
    // Line 0 is "aa\r", line 1 starts at offset 4
    // Replace from (0,2) to (1,0) — should delete "\r\n"
    const result = applyEdits(content, [
      edit(0, 2, 1, 0, ""),
    ]);
    assert.equal(result,"aabb");
  });

  // ---- Unicode and emoji ----

  it("handles unicode content correctly", () => {
    const content = "café";
    // "café" — the é is one JS char (U+00E9)
    const result = applyEdits(content, [
      edit(0, 0, 0, 4, "CAFÉ"),
    ]);
    assert.equal(result,"CAFÉ");
  });

  it("handles emoji content", () => {
    // "hi 👋 there" — 👋 is 2 JS chars (surrogate pair)
    const content = "hi 👋 there";
    // LSP character offsets use UTF-16 code units, same as JS string length
    // "hi " = 3 chars, "👋" = 2 chars, " there" = 6 chars
    // Replace "👋" (chars 3-5) with "🎉" (also 2 chars)
    const result = applyEdits(content, [
      edit(0, 3, 0, 5, "🎉"),
    ]);
    assert.equal(result,"hi 🎉 there");
  });

  // ---- Overlapping edits (potentially dangerous) ----

  it("overlapping edits: second edit starts inside first edit's range", () => {
    const content = "abcdef";
    // Edit 1: replace chars 1-4 ("bcd") with "X"
    // Edit 2: replace chars 2-5 ("cde") with "Y"
    // After sorting: edit1 (start=1) comes first, cursor advances to 4
    // edit2 (start=2) has start < cursor(4), so no gap, but edit2's
    // newText "Y" is still pushed and cursor goes to 5.
    // This produces: "a" + "X" + "Y" + "f" = "aXYf"
    // The overlap means chars 2-4 are "deleted twice" — 'c' and 'd' appear
    // in both edit ranges. The implementation doesn't detect this.
    const result = applyEdits(content, [
      edit(0, 1, 0, 4, "X"),
      edit(0, 2, 0, 5, "Y"),
    ]);
    assert.equal(result,"aXYf");
  });

  // ---- Realistic Tailwind scenarios ----

  it("fixes className with multiple bracket notations", () => {
    const content = `<div className="w-[1200px] h-[630px] overflow-hidden">`;
    // w-[1200px] = chars 16-26 (end exclusive), h-[630px] = chars 27-36 (end exclusive)
    const result = applyEdits(content, [
      edit(0, 16, 0, 26, "w-300"),
      edit(0, 27, 0, 36, "h-157.5"),
    ]);
    assert.equal(result,`<div className="w-300 h-157.5 overflow-hidden">`);
  });

  it("fixes multi-line JSX with edits on different lines", () => {
    const content = [
      `<div`,
      `  className="z-[1] flex-shrink-0"`,
      `  style={{}}`,
      `/>`,
    ].join("\n");
    // z-[1] starts at char 13 on line 1, flex-shrink-0 at char 19
    const result = applyEdits(content, [
      edit(1, 13, 1, 18, "z-1"),
      edit(1, 19, 1, 32, "shrink-0"),
    ]);
    const expected = [
      `<div`,
      `  className="z-1 shrink-0"`,
      `  style={{}}`,
      `/>`,
    ].join("\n");
    assert.equal(result,expected);
  });

  // ---- Trailing newline ----

  it("preserves trailing newline", () => {
    const content = "hello\n";
    const result = applyEdits(content, [
      edit(0, 0, 0, 5, "world"),
    ]);
    assert.equal(result,"world\n");
  });

  it("edit on the empty last line after trailing newline", () => {
    const content = "hello\n";
    // Line 1 exists (empty, after the \n). Insert there.
    const result = applyEdits(content, [
      edit(1, 0, 1, 0, "world"),
    ]);
    assert.equal(result,"hello\nworld");
  });

  // ---- Stress: many edits ----

  it("handles 50 edits across 50 lines", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-old`);
    const content = lines.join("\n");
    const edits = lines.map((_, i) => {
      const old = `line-${i}-old`;
      return edit(i, 0, i, old.length, `line-${i}-new`);
    });
    const result = applyEdits(content, edits);
    const expected = Array.from({ length: 50 }, (_, i) => `line-${i}-new`).join("\n");
    assert.equal(result,expected);
  });

  // ---- Zero-width replacements at various positions ----

  it("multiple zero-width inserts at different positions", () => {
    const content = "ac";
    const result = applyEdits(content, [
      edit(0, 1, 0, 1, "b"),  // insert 'b' between 'a' and 'c'
    ]);
    assert.equal(result,"abc");
  });

  it("multiple zero-width inserts at the same position", () => {
    // Two inserts at position 1 — both have start=end=1
    // After sorting they're both at offset 1, first insert "X", cursor stays at 1,
    // second insert "Y", cursor stays at 1
    const content = "ac";
    const result = applyEdits(content, [
      edit(0, 1, 0, 1, "X"),
      edit(0, 1, 0, 1, "Y"),
    ]);
    // Both inserts land at offset 1: "a" + "X" + "Y" + "c"
    assert.equal(result,"aXYc");
  });

  // ---- Edit that replaces entire content ----

  it("replaces entire content with single edit", () => {
    const content = "old content\nwith multiple\nlines";
    const result = applyEdits(content, [
      edit(0, 0, 2, 5, "new"),
    ]);
    assert.equal(result,"new");
  });

  // ---- Only newlines ----

  it("handles content that is only newlines", () => {
    const content = "\n\n\n";
    const result = applyEdits(content, [
      edit(1, 0, 1, 0, "inserted"),
    ]);
    assert.equal(result,"\ninserted\n\n");
  });

  // ---- Probing for subtle bugs ----

  it("edit where replacement is longer than original (grows the line)", () => {
    const content = "ab";
    const result = applyEdits(content, [
      edit(0, 0, 0, 1, "AAAA"),  // replace 'a' (1 char) with 'AAAA' (4 chars)
    ]);
    assert.equal(result,"AAAAb");
  });

  it("edit where replacement is shorter than original (shrinks the line)", () => {
    const content = "aaaab";
    const result = applyEdits(content, [
      edit(0, 0, 0, 4, "X"),  // replace 'aaaa' (4 chars) with 'X' (1 char)
    ]);
    assert.equal(result,"Xb");
  });

  it("two edits where first shrinks and second uses original offsets", () => {
    // This is the key scenario: after first edit shrinks, do second edit's
    // original offsets still work correctly?
    const content = "aaa bbb ccc";
    // Replace 'aaa' (0-3) with 'x', replace 'ccc' (8-11) with 'z'
    const result = applyEdits(content, [
      edit(0, 0, 0, 3, "x"),
      edit(0, 8, 0, 11, "z"),
    ]);
    // Since we use original offsets: "x" + content[3:8]=" bbb " + "z"
    assert.equal(result,"x bbb z");
  });

  it("two edits where first grows and second uses original offsets", () => {
    const content = "a b c";
    const result = applyEdits(content, [
      edit(0, 0, 0, 1, "XXXX"),  // 'a' → 'XXXX'
      edit(0, 4, 0, 5, "ZZZZ"),  // 'c' → 'ZZZZ'
    ]);
    assert.equal(result,"XXXX b ZZZZ");
  });

  it("edit that deletes everything and inserts nothing", () => {
    const content = "hello\nworld";
    const result = applyEdits(content, [
      edit(0, 0, 1, 5, ""),
    ]);
    assert.equal(result,"");
  });

  it("edit range with end before start (invalid range)", () => {
    // Pathological: end offset < start offset after conversion
    // toOffset(0,5) = 5, toOffset(0,2) = 2 → start=5, end=2
    // After sort, this edit has start=5 > cursor=0, so we'd push content[0:5]
    // then push newText, then cursor=2 which is < 5...
    // This should behave oddly. Let's see what happens.
    const content = "abcdef";
    const result = applyEdits(content, [
      edit(0, 5, 0, 2, "X"),  // start > end
    ]);
    // start=5, end=2: push "abcde" (0-5), push "X", cursor=2
    // cursor(2) < content.length(6), push content[2:] = "cdef"
    // Result: "abcdeXcdef" — the reversed range causes duplication
    assert.equal(result,"abcdeXcdef");
  });

  it("consecutive edits that delete and insert on multi-line content", () => {
    const content = "line1\nline2\nline3\nline4\nline5";
    // Delete line2, replace line4 with NEW4
    const result = applyEdits(content, [
      edit(1, 0, 2, 0, ""),          // delete "line2\n"
      edit(3, 0, 3, 5, "NEW4"),      // replace "line4" with "NEW4"
    ]);
    assert.equal(result,"line1\nline3\nNEW4\nline5");
  });

  it("edit at exact end of content (no trailing newline)", () => {
    const content = "end";
    const result = applyEdits(content, [
      edit(0, 3, 0, 3, "!"),
    ]);
    assert.equal(result,"end!");
  });

  it("many edits on the same line, varying replacement lengths", () => {
    // Simulates what the LSP might do with a class like:
    // "z-[1] flex-shrink-0 bg-primary/[0.06] min-w-[200px] h-[1px]"
    const content = `className="z-[1] flex-shrink-0 bg-primary/[0.06] min-w-[200px] h-[1px]"`;
    const result = applyEdits(content, [
      edit(0, 11, 0, 16, "z-1"),              // z-[1] → z-1
      edit(0, 17, 0, 30, "shrink-0"),          // flex-shrink-0 → shrink-0
      edit(0, 31, 0, 48, "bg-primary/6"),      // bg-primary/[0.06] → bg-primary/6
      edit(0, 49, 0, 62, "min-w-50"),           // min-w-[200px] → min-w-50
      edit(0, 63, 0, 70, "h-px"),              // h-[1px] → h-px
    ]);
    assert.equal(result,`className="z-1 shrink-0 bg-primary/6 min-w-50 h-px"`);
  });

  it("single char file with replacement", () => {
    assert.equal(applyEdits("x", [edit(0, 0, 0, 1, "y")]),"y");
  });

  it("edit newText contains newlines (splitting a line)", () => {
    const content = "before after";
    const result = applyEdits(content, [
      edit(0, 6, 0, 7, "\n"),  // replace space with newline
    ]);
    assert.equal(result,"before\nafter");
  });

  it("edit that joins lines by replacing newline with space", () => {
    const content = "before\nafter";
    // The \n is at the end of line 0 (char 6 = the newline itself?).
    // Actually, line 0 is "before", line 1 is "after".
    // Range (0,6) to (1,0) covers just the \n character.
    const result = applyEdits(content, [
      edit(0, 6, 1, 0, " "),
    ]);
    assert.equal(result,"before after");
  });
});
