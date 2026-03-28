/**
 * tailwint — Tailwind CSS linter powered by the official language server.
 *
 * Usage:  tailwint [--fix] [glob...]
 *         tailwint                              # default: **\/*.{tsx,jsx,html,vue,svelte,astro,mdx,css}
 *         tailwint --fix                        # auto-fix all issues
 *         tailwint "src/**\/*.tsx"               # custom glob
 *
 * Set DEBUG=1 for verbose LSP message logging.
 */

import { resolve, relative } from "path";
import { readFileSync } from "fs";
import { glob } from "glob";

import {
  startServer,
  send,
  notify,
  shutdown,
  fileUri,
  langId,
  diagnosticsReceived,
  settledProjects,
  brokenProjects,
  warnings,
  waitForAllProjects,
  resetState,
} from "./lsp.js";
import { fixFile } from "./edits.js";
import { prescanCssFiles } from "./prescan.js";
import {
  c,
  isTTY,
  setTitle,
  windTrail,
  braille,
  windWave,
  dots,
  tick,
  advanceTick,
  startSpinner,
  progressBar,
  banner,
  fileBadge,
  diagLine,
  rainbowText,
  celebrationAnimation,
} from "./ui.js";

// Re-export for tests
export { applyEdits, type TextEdit } from "./edits.js";

const DEFAULT_PATTERNS = ["**/*.{tsx,jsx,html,vue,svelte,astro,mdx,css}"];

export interface TailwintOptions {
  patterns?: string[];
  fix?: boolean;
  cwd?: string;
}

export async function run(options: TailwintOptions = {}): Promise<number> {
  resetState();
  const t0 = Date.now();
  const cwd = resolve(options.cwd || process.cwd());
  const fix = options.fix ?? false;
  const patterns = options.patterns ?? DEFAULT_PATTERNS;

  const fileSet = new Set<string>();
  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd,
      absolute: true,
      nodir: true,
      ignore: [
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/out/**",
        "**/coverage/**",
        "**/public/**",
        "**/tmp/**",
        "**/.tmp/**",
        "**/.cache/**",
        "**/vendor/**",
        "**/storybook-static/**",
        "**/.next/**",
        "**/.nuxt/**",
        "**/.output/**",
        "**/.svelte-kit/**",
        "**/.astro/**",
        "**/.vercel/**",
        "**/.expo/**",
      ],
    });
    for (const m of matches) fileSet.add(m);
  }
  const files = [...fileSet];

  await banner();

  if (files.length === 0) {
    const VP = 54;
    const l1 = "the wind blows";
    const l2 = "but there is nothing here";
    const l3 = "~ no files matched ~";
    const p1 = 4;
    const p2 = Math.floor((VP - l2.length - 2) / 2);
    const p3 = VP - l3.length - 8;
    const lw1 = p1, rw1 = VP - p1 - l1.length - 2;
    const lw2 = p2, rw2 = VP - p2 - l2.length - 2;
    const lw3 = p3, rw3 = VP - p3 - l3.length - 2;
    console.error(`  ${windTrail(lw1)} ${c.dim}${l1}${c.reset} ${windTrail(rw1, 4)}`);
    console.error(`  ${windTrail(lw2, 2)} ${c.dim}${l2}${c.reset} ${windTrail(rw2, 7)}`);
    console.error(`  ${windTrail(lw3, 5)} ${c.dim}${c.italic}${l3}${c.reset} ${windTrail(rw3, 9)}`);
    console.error("");
    return 0;
  }

  // Phase 1: Boot the LSP
  setTitle("tailwint ~ booting...");
  const stopBoot = startSpinner(() => {
    setTitle(`tailwint ~ booting${".".repeat(Date.now() % 4)}`);
    return `  ${braille()} ${c.dim}booting language server${dots()}${c.reset}  ${windTrail(24, tick)}`;
  });

  startServer(cwd);

  await send("initialize", {
    processId: process.pid,
    rootUri: fileUri(cwd),
    capabilities: {
      textDocument: {
        publishDiagnostics: { relatedInformation: true },
        codeAction: {
          codeActionLiteralSupport: {
            codeActionKind: { valueSet: ["quickfix"] },
          },
        },
      },
      workspace: { workspaceFolders: true, configuration: true },
    },
    workspaceFolders: [{ uri: fileUri(cwd), name: "workspace" }],
  });

  notify("initialized", {});
  stopBoot();
  console.error(
    `  ${c.green}\u2714${c.reset} ${c.dim}language server ready${c.reset} ${windTrail(30)}`,
  );

  // Pre-scan CSS files to predict project count
  const prescan = prescanCssFiles(files);

  // Open found files — triggers the server's project discovery
  const fileContents = new Map<string, string>();
  const fileVersions = new Map<string, number>();
  const skipped = prescan.unrelatedCssFiles.size;

  let sent = 0;
  for (const filePath of files) {
    // Skip CSS files with no Tailwind signals — sending them wastes server CPU
    if (prescan.unrelatedCssFiles.has(filePath)) continue;

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue; // file may have been deleted between glob and read
    }
    fileContents.set(filePath, content);
    fileVersions.set(filePath, 1);

    notify("textDocument/didOpen", {
      textDocument: {
        uri: fileUri(filePath),
        languageId: langId(filePath),
        version: 1,
        text: content,
      },
    });
    sent++;
  }

  const sentText = `sent ${sent} file${sent === 1 ? "" : "s"} to lsp`;
  const sentPad = 54 - 2 - sentText.length - 1;
  console.error(
    `  ${c.green}\u2714${c.reset} ${c.dim}${sentText}${c.reset} ${windTrail(sentPad)}`,
  );

  if (skipped > 0) {
    const skipText = `${skipped} file${skipped === 1 ? "" : "s"} skipped`;
    const skipPad = 54 - 2 - skipText.length - 1;
    console.error(
      `  ${c.dim}\u2500${c.reset} ${c.dim}${skipText}${c.reset} ${windTrail(skipPad)}`,
    );
    for (const f of prescan.unrelatedCssFiles) {
      const rel = relative(cwd, f);
      console.error(`    ${c.dim}${fileBadge(rel)}${c.reset}`);
    }
  }

  // Wait for all projects to be resolved (settled or broken)
  setTitle("tailwint ~ scanning...");
  const stopScan = startSpinner(() => {
    const received = diagnosticsReceived.size;
    const resolved = settledProjects + brokenProjects;
    const label = received > 0 ? "scanning" : "initializing";
    setTitle(`tailwint ~ ${label} ${resolved}/${prescan.maxProjects}`);
    const pct = sent > 0 ? Math.round((received / sent) * 100) : 0;
    const bar = progressBar(pct, 18, true);
    const totalStr = String(sent);
    const recvStr = String(received).padStart(totalStr.length);
    const usedCols = 2 + 1 + 1 + 20 + 1 + label.length + 3 + 1 - 2;
    const waveCols = Math.max(0, 54 - usedCols);
    // labelCol = 2(indent) + 1(braille) + 1(space) + 20(bar) + 1(space) = 25
    // "received" starts at labelCol, numbers right-aligned before it
    const countStr = `${recvStr}/${totalStr}`;
    const countPad = " ".repeat(Math.max(0, 25 - countStr.length - 1));
    const recvLabel = "files received";
    const recvUsed = countPad.length + countStr.length + 1 + recvLabel.length + 1 - 2;
    const recvWave = Math.max(0, 54 - recvUsed);
    return `  ${braille()} ${bar} ${c.dim}${label}${dots()}${c.reset} ${windTrail(waveCols, tick)}\n${countPad}${c.bold}${countStr}${c.reset} ${c.dim}${recvLabel}${c.reset} ${windTrail(recvWave, tick + 3)}`;
  }, 80);

  await waitForAllProjects(prescan.predictedRoots, prescan.maxProjects);
  stopScan();

  // Log warnings for broken projects
  for (const w of warnings) {
    console.error(`  ${c.yellow}\u26A0${c.reset} ${c.dim}${w}${c.reset}`);
  }

  const scanned = diagnosticsReceived.size;
  const scannedText = `${scanned}/${sent} files received`;
  const scannedPad = 54 - 2 - scannedText.length - 1;
  console.error(
    `  ${c.green}\u2714${c.reset} ${c.dim}${scannedText}${c.reset} ${windTrail(scannedPad)}`,
  );
  console.error("");

  // Collect issues
  let totalIssues = 0;
  const issuesByFile = new Map<string, any[]>();

  for (const filePath of files) {
    const diags = diagnosticsReceived.get(fileUri(filePath)) || [];
    const meaningful = diags.filter(
      (d: any) => d.severity === 1 || d.severity === 2,
    );
    if (meaningful.length > 0) {
      issuesByFile.set(filePath, meaningful);
      totalIssues += meaningful.length;
    }
  }

  const conflicts = [...issuesByFile.values()]
    .flat()
    .filter((d: any) => d.code === "cssConflict").length;
  const canonical = totalIssues - conflicts;

  // All clear
  if (totalIssues === 0) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    setTitle("tailwint \u2714 all clear");
    await celebrationAnimation();
    console.error(
      `  ${c.green}\u2714${c.reset} ${c.bold}${scanned}${c.reset} files scanned ${c.dim}// ${rainbowText("all clear")} ${c.dim}${elapsed}s${c.reset}`,
    );
    console.error("");
    await shutdown();
    return 0;
  }

  // Summary
  console.error(
    `  ${c.bold}${c.white}${scanned}${c.reset} files scanned ${c.dim}//${c.reset} ${c.orange}${c.bold}${conflicts}${c.reset}${c.orange} conflicts${c.reset} ${c.dim}\u2502${c.reset} ${c.yellow}${c.bold}${canonical}${c.reset}${c.yellow} canonical${c.reset}`,
  );
  console.error("");

  // Report
  let fileNum = 0;
  for (const [filePath, diags] of issuesByFile) {
    if (fileNum > 0) console.log(`    ${c.dim}${windWave()}${c.reset}`);
    fileNum++;
    const rel = relative(cwd, filePath);
    console.log(
      `  ${c.dim}\u250C${c.reset} ${fileBadge(rel)} ${c.dim}(${diags.length})${c.reset}`,
    );
    for (const d of diags) {
      console.log(diagLine(d));
    }
    console.log(`  ${c.dim}\u2514${windTrail(3)}${c.reset}`);
    advanceTick();
  }

  // Fix
  if (fix) {
    console.error("");
    console.error(
      `  ${c.bgCyan}${c.bold} \u2699 FIX ${c.reset} ${c.dim}conflicts first, then canonical${c.reset}`,
    );
    console.error("");

    let totalFixed = 0;
    let totalSkipped = 0;
    let fileIdx = 0;
    for (const [filePath, diags] of issuesByFile) {
      fileIdx++;
      const rel = relative(cwd, filePath);

      let pass = 0;
      const shortName = rel.includes("/")
        ? rel.slice(rel.lastIndexOf("/") + 1)
        : rel;
      setTitle(
        `tailwint ~ fixing ${shortName} (${fileIdx}/${issuesByFile.size})`,
      );
      const stopFix = startSpinner(() => {
        const pct = Math.round(
          ((fileIdx - 1 + pass / 10) / issuesByFile.size) * 100,
        );
        const bar = progressBar(pct, 18, true);
        const passText = `pass ${pass}`;
        const fixUsed = 2 + 20 + shortName.length + 1 + passText.length + 3 + 1;
        const fixWave = Math.max(0, 56 - fixUsed);
        return `  ${braille()} ${bar} ${c.bold}${c.white}${shortName}${c.reset} ${c.dim}${passText}${dots()}${c.reset} ${windTrail(fixWave, tick)}`;
      });

      const result = await fixFile(
        filePath,
        diags,
        fileContents,
        fileVersions,
        (p: number) => {
          pass = p;
        },
      );
      stopFix();

      const fixed = result.initial - result.remaining;
      totalFixed += fixed;
      totalSkipped += result.remaining;

      const pct = Math.round((fileIdx / issuesByFile.size) * 100);
      const bar = progressBar(pct, 18);
      const skipNote = result.remaining > 0
        ? ` ${c.dim}(${result.remaining} skipped)${c.reset}`
        : "";
      console.error(
        `  ${c.green}\u2714${c.reset} ${bar} ${c.bold}${c.white}${shortName}${c.reset} ${c.green}${fixed} fixed${c.reset}${skipNote}`,
      );
    }
    console.error("");
    const fixElapsed = ((Date.now() - t0) / 1000).toFixed(1);
    setTitle(`tailwint \u2714 fixed ${totalFixed} issues`);
    await celebrationAnimation();
    const skipSummary = totalSkipped > 0
      ? ` ${c.dim}(${totalSkipped} unfixable)${c.reset}`
      : "";
    console.error(
      `  ${windWave()} ${c.bgGreen}${c.bold} \u2714 FIXED ${c.reset} ${c.green}${c.bold}${totalFixed}${c.reset} of ${c.bold}${totalIssues}${c.reset} issues across ${c.bold}${issuesByFile.size}${c.reset} files ${c.dim}${fixElapsed}s${c.reset}${skipSummary} ${windWave()}`,
    );
    console.error("");
    await shutdown();
    return totalSkipped > 0 ? 1 : 0;
  }

  // Fail
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  setTitle(`tailwint \u2718 ${totalIssues} issues`);
  console.log("");
  console.log(
    `  ${windWave()} ${c.bgRed}${c.bold} \u2718 FAIL ${c.reset} ${c.red}${c.bold}${totalIssues}${c.reset} issues in ${c.bold}${issuesByFile.size}${c.reset} files ${c.dim}${elapsed}s${c.reset} ${windWave()}`,
  );
  console.log(
    `  ${c.dim}run with ${c.white}--fix${c.dim} to auto-fix${c.reset}`,
  );
  console.log("");
  await shutdown();
  return 1;
}
