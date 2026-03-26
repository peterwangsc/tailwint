# tailwint

Tailwind CSS linter for CI. Drives the official `@tailwindcss/language-server` to catch class errors and auto-fix them — the same diagnostics VS Code shows, but from the command line.

Works with Tailwind CSS v4.

## Install

```bash
npm install -D tailwint @tailwindcss/language-server
```

## Usage

```bash
# Check default file types (tsx, jsx, html, vue, svelte)
npx tailwint

# Check specific files
npx tailwint "src/**/*.tsx"

# Auto-fix issues
npx tailwint --fix

# Fix specific files
npx tailwint --fix "app/**/*.tsx"
```

## Programmatic API

```ts
import { run } from "tailwint";

const exitCode = await run({
  patterns: ["src/**/*.tsx"],
  fix: true,
  cwd: "/path/to/project",
});
```

## How it works

tailwint spawns the official Tailwind CSS language server over stdio, opens your files via LSP, and collects the published diagnostics. In `--fix` mode it requests quickfix code actions and applies the resulting edits.

## Requirements

- Node.js 18+
- `@tailwindcss/language-server` >= 0.14.0 (peer dependency)

## License

MIT
