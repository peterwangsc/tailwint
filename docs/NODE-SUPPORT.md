# Assessing a change to the minimum Node version

Checked 2026-09-15 while preparing 1.1.16. There is currently no defensible
estimate of the percentage of Tailwint users running Node 18 (or Node 20).

## Download counts do not identify runtimes

The [npm downloads API](https://github.com/npm/registry/blob/main/docs/download-counts.md)
provides package/date and package-version counts, not consumer Node versions,
unique users, or the fraction enabling strict engine enforcement.

At the time checked, the point endpoints returned:

| Period actually returned | Tailwint downloads |
| --- | ---: |
| 2026-08-13 through 2026-09-11 | 2,410 |
| 2026-09-05 through 2026-09-11 | 1,026 |

Sources: [30-day endpoint](https://api.npmjs.org/downloads/point/last-month/tailwint)
and [7-day endpoint](https://api.npmjs.org/downloads/point/last-week/tailwint).
These are rolling endpoints; future responses will differ. The returned dates
lagged the check date. The separate per-version endpoint returned a different
aggregate total, so its counts were not combined with the point counts.

Repeated CI downloads and caches make downloads unsuitable as a unique-user
count. Registry metadata such as a package's `_nodeVersion` describes its
publisher's environment, not its consumers.

## Public consumer sample

GitHub code search for `tailwint filename:package.json`, excluding the package
itself and private results, found seven public consuming repositories across
three owners. All seven manifests specified `^1.1.15`.

| Consumer | Observed runtime signal |
| --- | --- |
| [unstackedapps/opensuitemcp](https://github.com/unstackedapps/opensuitemcp/blob/HEAD/package.json) | Node `>=22`; its Tailwind lint workflow explicitly selects Node 22 |
| [rossrobino/blog](https://github.com/rossrobino/blog/blob/HEAD/package.json) | No explicit runtime pin in the inspected manifest/root runtime files |
| [orochibraru/penombre](https://github.com/orochibraru/penombre/blob/HEAD/package.json) | Bun package manager and Bun CI tooling |
| [orochibraru/nuvio-web](https://github.com/orochibraru/nuvio-web/blob/HEAD/package.json) | Bun CI/build tooling |
| [orochibraru/homerun](https://github.com/orochibraru/homerun/blob/HEAD/package.json) | Bun install/lint/build tooling |
| [orochibraru/orochibraru](https://github.com/orochibraru/orochibraru/blob/HEAD/package.json) | Bun build/container tooling |
| [orochibraru/docs](https://github.com/orochibraru/docs/blob/HEAD/package.json) | Bun `>=1.2.0`; release job separately selects Node 24 |

No inspected consumer explicitly selected Node 18. This is not evidence that
zero users need it: five repositories belong to one owner, the sample is not
random, code search is incomplete as a consumer inventory, and a Bun workflow
can still launch Tailwint through its Node shebang. A GitHub Action's own Node
runtime also does not establish the runtime used by a project's lint command.

[Issue #1](https://github.com/peterwangsc/tailwint/issues/1) explicitly describes
use in a proprietary codebase, confirming that public repositories miss some
real usage. Neither that report nor its corroborating comment supplies a Node
version.

## Release decision

Preserve the declared Node 18 contract in the 1.1.16 patch. See
[the dependency tradeoff](RELEASING.md#node-18-dependency-compatibility).
For a later breaking release, collect voluntary Node/Bun version reports from
known users and add runtime/version fields to future bug reports. Responses
would be a self-selected sample, not a complete census. Raising the minimum to
Node 22 would affect Node 20 users as well as Node 18 users.

No outreach, analytics, or telemetry was added or sent as part of this check.
