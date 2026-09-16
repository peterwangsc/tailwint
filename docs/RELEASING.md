# Releasing Tailwint

Releases are published manually from a validated local package. CI tests pushes
and pull requests; it does not publish to npm.

## Published 1.1.16

Published to npm with the `latest` tag on 2026-09-15 (Pacific time), then tagged
at `f714996` and released on
[GitHub](https://github.com/peterwangsc/tailwint/releases/tag/v1.1.16).
The complete four-job CI matrix passed for that release commit in
[run 35051411180](https://github.com/peterwangsc/tailwint/actions/runs/35051411180).
After registry processing completed, its tarball matched the validated local
artifact byte-for-byte (SHA256 below); registry integrity and shasum also matched.
A fresh strict registry install passed all 13 real CLI/API lint/fix/rescan smoke
checks against language server 0.16.0 and Tailwind 4.0.17 on Mac Node 24.1.0.

Current registry release was checked as 1.1.15. The candidate fixes issue #1 and
the maintenance defects listed in CHANGELOG.md. Keep Node 18+ and the existing
language-server peer range; test the minimum supported and current server.

Before publishing:

1. Review and commit all candidate changes, including the independent autofix
   safety review.
2. Run `npm ci --engine-strict`, `npm run build`, `npm test`, and `npm audit`. Check Node 18 and
   24 on Mac/Windows and the Linux/Windows GitHub CI matrix.
3. Update package.json and package-lock.json together to 1.1.16 and commit the
   release notes. Confirm the tree is clean and the release commits are on GitHub.
4. Build and create the candidate with `npm pack --pack-destination tmp/release`.
   Inspect its file list; never include credentials, local fixtures, or bridge notes.
5. Install that tarball into a fresh directory. Check the CLI, programmatic API,
   real lint/fix/rescan, and the declared Node/server compatibility. Record the
   tarball SHA256 and verify no source changed after packing.
6. Confirm `npm whoami` works and `npm view tailwint version` still reports the
   expected previous version. Reauthenticate locally if necessary; do not put
   npm credentials in Git, notes, or chat.
7. Publish the exact tested tarball: `npm publish tmp/release/tailwint-1.1.16.tgz`.
8. Verify the registry version, package integrity, and a fresh registry install.
   Tag the release commit `v1.1.16` and publish release notes. Update issue #1
   only after the published package has been verified.

A candidate version or tarball is not a published release. Changes to the
candidate after testing require rebuilding and rechecking the affected behavior.

## Release validation — 2026-09-15

The maintenance fixes are committed as `28a33c2`, `d8cb375`, `38ce388`, and
`dfec713`, with dependency compatibility fixed in `401ad64`. Package and lockfile
versions are 1.1.16. Timeout/exclusion controls were added in `2626502`, release
notes finalized in `f812824`, and Windows backslash-ignore handling corrected
in `6aed0f9`. npm authentication is restored. The four-job Linux/Windows, Node
18/24 CI matrix passed for `6aed0f9` in
[run 35051194534](https://github.com/peterwangsc/tailwint/actions/runs/35051194534).

- Mac Node 18.20.8 and 24.1.0: 138 tests, 134 passed, four Windows-only skips.
- Windows Node 18.20.8 and 24.18.0: 138 tests, 136 passed, two POSIX-only skips.
  A separate Windows locked-file check correctly returned exit 2.
- Clean installs (including strict Node 18 engine checking), build/declaration
  generation, and the prepublish build/test checks passed;
  `npm audit` reported zero vulnerabilities.
- Fresh Mac tarball installation: 13 CLI/API checks passed per Node version against
  each official language server version 0.14.0 and 0.16.0, with Tailwind 4.0.17.
  Checks cover JSONC settings, TSX-only lint/fix/rescan, special filenames, CRLF,
  unknown flags, malformed configuration, and the package's public API.
- Fresh Windows tarball installations passed strict engine checks on Node 18
  and 24. The final artifact passed 37 CLI/API checks per runtime: 13 original
  smoke checks, 12 timeout/forward-slash-ignore checks, and 12 native-backslash
  ignore checks. Lint/fix/rescan preserved CRLF, special filenames, user-excluded
  files, and built-in output exclusions. Installed bin/dist files matched the
  tested tarball byte-for-byte on both runtimes.
- Bun 1.3.10 on Mac: installing the tarball with Bun passed, and the same
  13 CLI/API checks passed under both Node and the Bun runtime against server
  0.16.0. Reinstalling with Bun's isolated linker and rerunning under Bun also
  passed. Both `bun run tailwint` and `bun run --bun tailwint` passed real
  lint/fix/rescan checks. This is artifact smoke coverage; the full CI matrix
  remains Node.
- Exported TypeScript declarations compile in a fresh consumer project.
- All 17 packed files were inspected. No tests, temporary artifacts, bridge
  records, or credentials are included. The changelog is included.
- `npm publish --dry-run` on the tarball passed. Repacking after the clean
  install/build produced an identical tarball.

Local artifact: `tmp/release/tailwint-1.1.16.tgz` (ignored by Git).
Final artifact SHA256: `9c9775b2e80020bcf358b6e53e04786a46e71813114835b226210fc70a7b8ffe`.

### Timeout follow-up

The earlier full scan of the historical trainsim workspace still failed after
30.973 seconds. It selected four generated Chromium license HTML documents,
each approximately 15–16 MB. A source-only scan completed in 0.297 seconds;
the final API with `ignore: ["release/**"]` completed in 0.298 seconds (12/12
selected files received, exit 0). Selecting just one generated license page
exhausted a 1,500 ms deadline and exited 2 after 2.211 seconds including startup
and shutdown. These are single diagnostic reproductions, not benchmark medians.

The default remains 30 seconds, exposed through CLI `--timeout <ms>` and API
`timeoutMs`. Initial readiness, project lookup, and diagnostic delivery share
one budget; the LSP initialize handshake and autofix operations have separate
budgets. CLI `--ignore <glob>` and API `ignore` let callers omit generated trees
before reading or sending their files. Normal success has no fixed wait.

The first CI attempt failed only the JSONC integration test on Windows Node 18:
its artificial five-second hover budget expired. The PC reproduced the same
failure with six test processes restricted to two logical CPUs; unloaded runs
passed. The JSONC test now uses the production timeout with an outer 90-second
test limit. Dedicated fixture tests still verify stalled-server failure and
that initialization stages cannot each renew the deadline. The updated test
also passed all six deliberately contended Windows copies (approximately
12 seconds each).

Fresh Windows artifact testing caught a backslash-ignore defect: glob
10 does not apply `windowsPathsNoEscape` to its ignore matcher. Additional
ignore patterns are now normalized on Windows before matching, with a dedicated
API/CLI regression covering paths containing spaces, percent, hash, and Unicode.

The timeout-control tarball was rechecked on Mac Node 18/24 with language
servers 0.14.0 and 0.16.0, and with Bun against 0.16.0 (13 artifact checks in each
combination). After the Windows-only ignore correction, the final tarball passed
those 13 artifact checks again on Mac Node 18/24 and Bun against server 0.16.0.
A strict Node 18 install passed, npm audit reported zero vulnerabilities, and
all 17 packed file entries and the publish dry run were checked again.

## Node 18 dependency compatibility

A fresh strict Node 18.20.8/npm 10.3.0 installation of the initial candidate
failed with `EBADENGINE`: glob 13's transitive brace-expansion 5 and lru-cache 11
declare Node 20 or newer. Runtime tests alone did not catch that install failure.
The revised candidate uses glob 10.5.0 and a compatible dependency tree, and CI
runs `npm ci --engine-strict` on every supported matrix entry.

Upstream deprecates the glob 10 release line. Its
[published security advisory](https://github.com/isaacs/node-glob/security/advisories/GHSA-5j98-mcp5-4vw2)
names 10.5.0 as patched, and the resolved dependency tree currently reports zero
npm audit findings. Retaining this older dependency line preserves the existing
Node 18 contract in a patch release; it is a maintenance tradeoff, not a promise
of future upstream support. A future breaking release should raise the Node
minimum and return to the current glob line, or evaluate an actively maintained
replacement with equivalent pattern behavior.

## Release evidence

- [Measured performance comparison and reproduction](PERFORMANCE.md): complete
  98-file scans took 45.3% less elapsed time on Mac and 40.1% less on Windows in
  the pinned fixtures. TSX-only results are a correctness fix, not a speed claim.
- [Runtime-adoption assessment](NODE-SUPPORT.md): download counts and the small
  public consumer sample cannot establish a reliable Node 18 user percentage.
