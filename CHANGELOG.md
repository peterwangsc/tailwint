# Changelog

## 1.1.16 — release candidate

- Fix premature “all clear” results on large workspaces and TSX-only scans (#1).
  Wait for language-server initialization and each file's diagnostics instead
  of estimating project counts or treating gaps in output as completion.
- Return exit 2 for incomplete scans, server failures, missing diagnostics,
  unreadable files, invalid settings, and failed fix validation.
- Fix Windows relative backslash patterns, escaped file URIs, and code-action
  URI matching for spaces, percent signs, hashes, and Unicode filenames.
- Validate autofix ranges and preserve whole actions, including ordered insertions.
  Defer overlapping actions, reject stale document versions and repeated fix
  cycles, and preserve files edited or deleted during the scan.
- Leave unsupported multi-file or command-based actions unresolved instead of
  partially applying them; try usable alternatives after unsupported or no-op
  actions. Keep convergence uncapped and count resolved diagnostics, not edits.
- Parse VS Code settings as JSONC, preserving URLs and regular-expression
  strings, handling object and dotted sections safely, and rejecting malformed
  settings instead of silently dropping the user's lint configuration.
- Resolve hoisted language-server installs and package peers without relying
  on a shell executable being on PATH.
- Reject unknown CLI flags; support `--` for option-like filenames.
- Add `--timeout <ms>` and repeatable `--ignore <glob>` controls (API:
  `timeoutMs` and `ignore`). Initial readiness, project lookup, and diagnostic
  delivery share one deadline instead of renewing the timeout at each stage.
- Reject concurrent `run()` calls without disrupting the active run. Validate
  the new `timeoutMs` option before handing values to Node timers.
- Use the Node 18-compatible glob dependency line so strict engine checks do
  not reject installations through Node 20-only transitive dependencies.
- Update vulnerable dependencies, add portable build/test commands, and run
  regression checks on Linux and Windows with Node 18 and 24.
