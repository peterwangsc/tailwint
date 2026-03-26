#!/usr/bin/env node
import { run } from "../dist/index.js";
import { c, isTTY } from "../dist/ui.js";

const args = process.argv.slice(2);
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
