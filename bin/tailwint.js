#!/usr/bin/env node
import { run } from "../dist/index.js";
import { c, isTTY } from "../dist/ui.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  Usage: tailwint [--fix] [glob...]

  Options:
    --fix       Auto-fix all issues using LSP code actions
    --help      Show this help message
    --version   Show version number

  Examples:
    tailwint                          Scan default file types
    tailwint "src/**/*.tsx"           Scan specific files
    tailwint --fix                    Auto-fix all issues
    tailwint --fix "app/**/*.tsx"     Fix specific files

  Environment:
    DEBUG=1     Verbose LSP message logging
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  console.log(pkg.version);
  process.exit(0);
}

const fix = args.includes("--fix");
const patterns = args.filter((a) => a !== "--fix");

run({ fix, patterns: patterns.length > 0 ? patterns : undefined }).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\n  ${c.red}${c.bold}tailwint crashed:${c.reset} ${err}`);
    process.stderr.write(isTTY ? "\x1b[?25h" : "");
    process.exit(2);
  },
);
