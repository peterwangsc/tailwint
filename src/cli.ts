#!/usr/bin/env node

/**
 * tailwint — Tailwind CSS linter that drives the official language server.
 *
 * Usage:  tailwint [--fix] [glob...]
 *         tailwint                              # default: **\/*.{tsx,jsx,html,vue,svelte}
 *         tailwint --fix                        # auto-fix all issues
 *         tailwint "src/**\/*.tsx"               # custom glob
 *         tailwint --fix "app/**\/*.tsx"          # fix specific files
 *
 * Set DEBUG=1 for verbose LSP message logging.
 */

import { run } from "./index.js";

const args = process.argv.slice(2);
const fix = args.includes("--fix");
const patterns = args.filter((a) => a !== "--fix");

run({ fix, patterns: patterns.length > 0 ? patterns : undefined }).then(
  (code) => process.exit(code),
  (err) => {
    console.error("tailwint failed:", err);
    process.exit(2);
  },
);
