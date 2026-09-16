# Releasing Tailwint

Releases are published manually from a validated local package. CI tests pushes
and pull requests; it does not publish to npm.

## Candidate 1.1.16

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

## Candidate validation — 2026-09-15

The maintenance fixes are committed as `28a33c2`, `d8cb375`, `38ce388`, and
`dfec713`, with a follow-up dependency compatibility fix. Package and lockfile
versions are 1.1.16. This remains an unpublished candidate; npm authentication returned E401. GitHub CI has not yet run for these
local commits.

- Mac Node 18.20.8 and 24.1.0: 132 tests, 129 passed, three Windows-only skips.
- Windows Node 18.20.8 and 24.18.0: 132 tests, 130 passed, two POSIX-only skips.
  A separate Windows locked-file check correctly returned exit 2.
- Clean installs (including strict Node 18 engine checking), build/declaration
  generation, and the prepublish build/test checks passed;
  `npm audit` reported zero vulnerabilities.
- Fresh Mac tarball installation: 13 CLI/API checks passed per Node version against
  each official language server version 0.14.0 and 0.16.0, with Tailwind 4.0.17.
  Checks cover JSONC settings, TSX-only lint/fix/rescan, special filenames, CRLF,
  unknown flags, malformed configuration, and the package's public API.
- Fresh Windows tarball installations passed strict engine checks on Node 18
  and 24. All 13 CLI/API checks and the npm command shim passed on each,
  including special paths, backslash patterns, and CRLF preservation.
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
SHA256: `d605dedbcb3b4d1008e784dc3340b75f3f1b68e99c8be2cb832d2280bb258d80`.

Before publication, push the reviewed commits and require the CI matrix to
pass, restore npm authentication, and
confirm the registry is still at the expected previous release.

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
