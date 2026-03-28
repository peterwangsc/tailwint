/**
 * Tests for analyzeStylesheet and prescanCssFiles from tailwint/prescan.ts
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { analyzeStylesheet, prescanCssFiles } from "../src/prescan.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";

// ---------------------------------------------------------------------------
// analyzeStylesheet
// ---------------------------------------------------------------------------

describe("analyzeStylesheet", () => {
  // ---- v4 explicit import ----

  it("detects @import 'tailwindcss' as v4 root with explicit import", () => {
    const r = analyzeStylesheet(`@import "tailwindcss";`);
    assert.equal(r.root, true);
    assert.deepEqual(r.versions, ["4"]);
    assert.equal(r.explicitImport, true);
  });

  it("detects @import 'tailwindcss/theme' as v4 root", () => {
    const r = analyzeStylesheet(`@import "tailwindcss/theme";`);
    assert.equal(r.root, true);
    assert.deepEqual(r.versions, ["4"]);
    assert.equal(r.explicitImport, true);
  });

  it("detects single-quoted tailwindcss import", () => {
    const r = analyzeStylesheet(`@import 'tailwindcss';`);
    assert.equal(r.root, true);
    assert.equal(r.explicitImport, true);
  });

  // ---- v4 directives (non-root) ----

  it("detects @theme as v4 non-root", () => {
    const r = analyzeStylesheet(`@theme {\n  --color-brand: #3b82f6;\n}`);
    assert.equal(r.root, false);
    assert.deepEqual(r.versions, ["4"]);
    assert.equal(r.explicitImport, false);
  });

  it("detects @plugin as v4 non-root", () => {
    const r = analyzeStylesheet(`@plugin "my-plugin";`);
    assert.equal(r.root, false);
    assert.deepEqual(r.versions, ["4"]);
  });

  it("detects @utility as v4 non-root", () => {
    const r = analyzeStylesheet(`@utility btn {\n  @apply px-4 py-2;\n}`);
    assert.equal(r.root, false);
    assert.deepEqual(r.versions, ["4"]);
  });

  it("detects @variant as v4 non-root", () => {
    const r = analyzeStylesheet(`@variant dark {\n  @media (prefers-color-scheme: dark);\n}`);
    assert.equal(r.root, false);
    assert.deepEqual(r.versions, ["4"]);
  });

  it("@theme + @tailwind utilities = v4 root", () => {
    const r = analyzeStylesheet(`@theme {\n  --color: red;\n}\n@tailwind utilities;`);
    // @theme matches first, but since @tailwind utilities is also present, root = true
    // Actually, HAS_V4_DIRECTIVE matches first and checks for HAS_TAILWIND_UTILITIES
    assert.equal(r.root, true);
    assert.deepEqual(r.versions, ["4"]);
  });

  // ---- v4 functions (non-root) ----

  it("detects --alpha() as v4 non-root", () => {
    const r = analyzeStylesheet(`.foo { color: --alpha(red, 50%); }`);
    assert.equal(r.root, false);
    assert.deepEqual(r.versions, ["4"]);
  });

  it("detects --spacing() as v4 non-root", () => {
    const r = analyzeStylesheet(`.foo { margin: --spacing(4); }`);
    assert.equal(r.root, false);
    assert.deepEqual(r.versions, ["4"]);
  });

  // ---- Legacy v3 ----

  it("detects @tailwind base as v3", () => {
    const r = analyzeStylesheet(`@tailwind base;`);
    assert.equal(r.root, false);
    assert.deepEqual(r.versions, ["3"]);
  });

  it("detects @tailwind components as v3", () => {
    const r = analyzeStylesheet(`@tailwind components;`);
    assert.equal(r.root, false);
    assert.deepEqual(r.versions, ["3"]);
  });

  // ---- Ambiguous (could be v3 or v4) ----

  it("detects @tailwind utilities as ambiguous root", () => {
    const r = analyzeStylesheet(`@tailwind utilities;`);
    assert.equal(r.root, true);
    assert.deepEqual(r.versions, ["4", "3"]);
  });

  it("detects @apply as ambiguous non-root", () => {
    const r = analyzeStylesheet(`.btn {\n  @apply px-4 py-2;\n}`);
    assert.equal(r.root, false);
    assert.deepEqual(r.versions, ["4", "3"]);
  });

  it("detects @config as ambiguous non-root", () => {
    const r = analyzeStylesheet(`@config "./tailwind.config.js";`);
    assert.equal(r.root, false);
    assert.deepEqual(r.versions, ["4", "3"]);
  });

  it("detects non-URL @import as ambiguous root", () => {
    const r = analyzeStylesheet(`@import "./styles/base.css";`);
    assert.equal(r.root, true);
    assert.deepEqual(r.versions, ["4", "3"]);
  });

  it("detects @import of a package as ambiguous root", () => {
    const r = analyzeStylesheet(`@import "some-package";`);
    assert.equal(r.root, true);
    assert.deepEqual(r.versions, ["4", "3"]);
  });

  // ---- Not Tailwind ----

  it("returns empty versions for plain CSS", () => {
    const r = analyzeStylesheet(`:root { --color: red; }\nbody { margin: 0; }`);
    assert.equal(r.root, false);
    assert.deepEqual(r.versions, []);
    assert.equal(r.explicitImport, false);
  });

  it("returns empty versions for CSS with only URL imports", () => {
    const r = analyzeStylesheet(`@import url("https://fonts.googleapis.com/css2?family=Inter");`);
    assert.equal(r.root, false);
    assert.deepEqual(r.versions, []);
  });

  it("returns empty versions for empty string", () => {
    const r = analyzeStylesheet("");
    assert.deepEqual(r.versions, []);
  });

  it("returns empty versions for CSS with only comments", () => {
    const r = analyzeStylesheet(`/* just a comment */`);
    assert.deepEqual(r.versions, []);
  });

  // ---- Edge cases ----

  it("matches @import tailwindcss inside a comment (known limitation)", () => {
    // This is a shared limitation with the language server — regex doesn't strip comments
    const r = analyzeStylesheet(`/* @import "tailwindcss"; */`);
    assert.equal(r.root, true);
    assert.equal(r.explicitImport, true);
  });

  it("does not match URL-style tailwindcss import", () => {
    const r = analyzeStylesheet(`@import url("tailwindcss");`);
    // url() imports don't match HAS_V4_IMPORT, but they also don't match HAS_NON_URL_IMPORT
    // because of the url() prefix. This should return no Tailwind signals.
    assert.deepEqual(r.versions, []);
  });

  it("prioritizes v4 import over other directives", () => {
    const r = analyzeStylesheet(`@import "tailwindcss";\n@tailwind base;\n@apply flex;`);
    // HAS_V4_IMPORT matches first
    assert.equal(r.root, true);
    assert.deepEqual(r.versions, ["4"]);
    assert.equal(r.explicitImport, true);
  });

  it("handles multiple @theme blocks", () => {
    const r = analyzeStylesheet(`@theme {\n  --a: 1;\n}\n@theme {\n  --b: 2;\n}`);
    assert.equal(r.root, false);
    assert.deepEqual(r.versions, ["4"]);
  });
});

// ---------------------------------------------------------------------------
// prescanCssFiles
// ---------------------------------------------------------------------------

describe("prescanCssFiles", () => {
  const testDir = resolve("tests/fixtures/prescan");

  // Set up test fixtures
  function setup() {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  }

  function writeFixture(name: string, content: string): string {
    const p = resolve(testDir, name);
    writeFileSync(p, content);
    return p;
  }

  it("classifies files correctly", () => {
    setup();
    const root = writeFixture("app.css", `@import "tailwindcss";`);
    const nonRoot = writeFixture("theme.css", `@theme {\n  --color: red;\n}`);
    const unrelated = writeFixture("plain.css", `body { margin: 0; }`);
    const tsx = resolve(testDir, "page.tsx"); // non-CSS file

    const result = prescanCssFiles([root, nonRoot, unrelated, tsx]);

    assert.equal(result.predictedRoots, 1);
    assert.equal(result.predictedNonRoots, 1);
    assert.equal(result.predictedUnrelated, 1);
    assert.equal(result.totalCssFiles, 3);
    assert.equal(result.maxProjects, 2);
    assert.equal(result.unrelatedCssFiles.size, 1);
    assert.equal(result.unrelatedCssFiles.has(unrelated), true);

    rmSync(testDir, { recursive: true, force: true });
  });

  it("skips non-CSS files entirely", () => {
    setup();
    const tsx = resolve(testDir, "page.tsx");
    writeFileSync(tsx, `export default function() { return <div className="flex">hi</div> }`);

    const result = prescanCssFiles([tsx]);

    assert.equal(result.totalCssFiles, 0);
    assert.equal(result.predictedRoots, 0);
    assert.equal(result.maxProjects, 0);

    rmSync(testDir, { recursive: true, force: true });
  });

  it("handles empty file list", () => {
    const result = prescanCssFiles([]);

    assert.equal(result.totalCssFiles, 0);
    assert.equal(result.maxProjects, 0);
    assert.equal(result.unrelatedCssFiles.size, 0);
  });

  it("handles missing files gracefully", () => {
    const result = prescanCssFiles(["/nonexistent/file.css"]);

    // File can't be read, so it's skipped entirely
    assert.equal(result.totalCssFiles, 0);
    assert.equal(result.maxProjects, 0);
  });

  it("counts multiple roots correctly", () => {
    setup();
    const a = writeFixture("a.css", `@import "tailwindcss";`);
    const b = writeFixture("b.css", `@import "tailwindcss";\n@theme { --x: 1; }`);
    const c = writeFixture("c.css", `@import "other-package";`);

    const result = prescanCssFiles([a, b, c]);

    assert.equal(result.predictedRoots, 3); // all three have @import → root: true
    assert.equal(result.predictedNonRoots, 0);
    assert.equal(result.maxProjects, 3);

    rmSync(testDir, { recursive: true, force: true });
  });

  it("unrelatedCssFiles contains exact paths", () => {
    setup();
    const root = writeFixture("app.css", `@import "tailwindcss";`);
    const plain1 = writeFixture("reset.css", `* { margin: 0; }`);
    const plain2 = writeFixture("vars.css", `:root { --x: 1; }`);

    const result = prescanCssFiles([root, plain1, plain2]);

    assert.equal(result.unrelatedCssFiles.size, 2);
    assert.equal(result.unrelatedCssFiles.has(plain1), true);
    assert.equal(result.unrelatedCssFiles.has(plain2), true);
    assert.equal(result.unrelatedCssFiles.has(root), false);

    rmSync(testDir, { recursive: true, force: true });
  });
});
