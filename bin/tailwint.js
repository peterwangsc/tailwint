#!/usr/bin/env node
import { run } from "../dist/index.js";
import { shutdown } from "../dist/lsp.js";
import { c, isTTY } from "../dist/ui.js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";

function cleanup(signal) {
  if (isTTY) process.stderr.write("\x1b[?25h\x1b[2K\r");
  shutdown().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
}
process.on("SIGINT", () => cleanup("SIGINT"));
process.on("SIGTERM", () => cleanup("SIGTERM"));

let fix = false;
let help = false;
let version = false;
let literal = false;
let timeoutMs;
const ignore = [];
const patterns = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (literal) patterns.push(arg);
  else if (arg === "--") literal = true;
  else if (arg === "--fix" || arg === "-f") fix = true;
  else if (arg === "--help" || arg === "-h") help = true;
  else if (arg === "--version" || arg === "-v") version = true;
  else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
    const value = arg === "--timeout" ? args[++i] : arg.slice("--timeout=".length);
    if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 2_147_483_647) {
      console.error("tailwint: --timeout requires an integer between 1 and 2147483647 milliseconds.");
      process.exit(2);
    }
    timeoutMs = Number(value);
  }
  else if (arg === "--ignore" || arg.startsWith("--ignore=")) {
    const value = arg === "--ignore" ? args[++i] : arg.slice("--ignore=".length);
    if (!value || (arg === "--ignore" && value.startsWith("-"))) {
      console.error("tailwint: --ignore requires a glob pattern. Use --ignore=<glob> for patterns starting with '-'.");
      process.exit(2);
    }
    ignore.push(value);
  }
  else if (arg.startsWith("-")) {
    console.error(`tailwint: unknown option ${arg}. Use --help for usage.`);
    process.exit(2);
  } else patterns.push(arg);
}

if (help) {
  console.log(`
  Usage: tailwint [--fix] [--timeout ms] [--ignore glob] [--] [glob...]

  Options:
    --fix       Auto-fix all issues using LSP code actions
    --timeout   Maximum wait in milliseconds (default: 30000)
    --ignore    Exclude a glob pattern; may be repeated
    --help      Show this help message
    --version   Show version number
    --          Treat remaining arguments as file patterns

  Examples:
    tailwint                          Scan default file types
    tailwint "src/**/*.tsx"           Scan specific files
    tailwint --fix                    Auto-fix all issues
    tailwint --fix "app/**/*.tsx"     Fix specific files
    tailwint --ignore "release/**"    Exclude generated release files
    tailwint --timeout 60000           Allow slower language-server operations

  Environment:
    DEBUG=1     Verbose LSP message logging
`);
  process.exit(0);
}

if (version) {
  const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  console.log(pkg.version);
  process.exit(0);
}

run({ fix, timeoutMs, ignore, patterns: patterns.length > 0 ? patterns : undefined }).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\n  ${c.red}${c.bold}tailwint crashed:${c.reset} ${err}`);
    process.stderr.write(isTTY ? "\x1b[?25h" : "");
    process.exit(2);
  },
);
