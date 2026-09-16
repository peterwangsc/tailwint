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
2. Run `npm ci`, `npm run build`, `npm test`, and `npm audit`. Check Node 18 and
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
`dfec713`. Package and lockfile versions are 1.1.16. This remains an unpublished
candidate; npm authentication returned E401. GitHub CI has not yet run for these
local commits.

- Mac Node 18.20.8 and 24.1.0: 132 tests, 129 passed, three Windows-only skips.
- Clean `npm ci`, build/declaration generation, and `prepublishOnly` passed;
  `npm audit` reported zero vulnerabilities.
- Fresh tarball installation: 13 CLI/API checks passed per Node version against
  each official language server version 0.14.0 and 0.16.0, with Tailwind 4.0.17.
  Checks cover JSONC settings, TSX-only lint/fix/rescan, special filenames, CRLF,
  unknown flags, malformed configuration, and the package's public API.
- Exported TypeScript declarations compile in a fresh consumer project.
- All 17 packed files were inspected. No tests, temporary artifacts, bridge
  records, or credentials are included. The changelog is included.
- `npm publish --dry-run` on the tarball passed. Repacking after the clean
  install/build produced an identical tarball.

Local artifact: `tmp/release/tailwint-1.1.16.tgz` (ignored by Git).
SHA256: `36318b40334a915e4a9e81f9f63b787175d8fe741a97752475321112179c767b`.

Before publication, finish Windows artifact verification, push the reviewed
commits and require the CI matrix to pass, restore npm authentication, and
confirm the registry is still at the expected previous release.
