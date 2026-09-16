# 1.1.16 performance comparison

Measured 2026-09-15 against the published npm package 1.1.15 and the final
1.1.16 candidate (`d605dedbcb3b4d1008e784dc3340b75f3f1b68e99c8be2cb832d2280bb258d80`).

## Mac results

Apple M4 Pro / arm64, Node 24.1.0. Both versions used language server 0.16.0
and Tailwind CSS 4.0.17. Each fixture contains two independent CSS entry points
and TSX files with two class-conflict diagnostics each.

| Scan | 1.1.15 median (range) | 1.1.16 median (range) | Correctness and improvement |
| --- | ---: | ---: | --- |
| 4 TSX + 2 CSS files | 1.036 s (1.033–1.045) | 0.562 s (0.544–0.569) | Both complete: 8 diagnostics; 45.7% less elapsed time |
| 96 TSX + 2 CSS files | 1.075 s (1.067–1.078) | 0.584 s (0.576–0.594) | Both complete: 192 diagnostics; 45.7% less elapsed time |
| 96 TSX, CSS omitted from glob | 0.165 s (0.164–0.168) | 0.587 s (0.576–0.595) | Old: false clean, 0/96 files received. New: 96/96 and 192 diagnostics. Not a speed comparison |

All five measured runs agreed on diagnostic counts and completion status.
The complete scans are about 1.84 times as fast on these fixtures. The roughly
half-second saving is consistent with replacing the old 500 ms diagnostic-gap
heuristic with explicit initialization and per-file completion checks. This is
an inference from the code and timings, not a CPU profile.

[Raw Mac observations](benchmarks/macos-2026-09-15.json) include every warmup,
measured duration, exit code, received-file count, and diagnostic count.

## Windows results

Intel Core i9-13900KF, Windows 10.0.26200, Node 24.18.0; the same language-server
and Tailwind versions as above. The independent PC run used 96 TSX files and two
CSS entry points, with the same 192 expected conflict diagnostics.

| Scan | 1.1.15 median (range) | 1.1.16 median (range) | Result |
| --- | ---: | ---: | --- |
| 96 TSX + 2 CSS files | 1.236 s (1.215–1.249) | 0.742 s (0.725–0.747) | Both complete; 40.0% less elapsed time, 1.67x as fast |
| 96 TSX, CSS omitted from glob | 0.213 s (0.211–0.214) | 0.735 s (0.720–0.755) | Old: false clean, 0/96. New: complete, 96/96. Not a speed comparison |

All five measured complete runs of each version produced the same per-file
normalized diagnostic signature. The Windows fixture also contained
`flex-shrink-0 z-[1]`, which this pinned Tailwind version does not report as
canonical diagnostics, and omitted the trailing newline. Inputs were identical
between versions on each machine; do not use the cross-machine absolute times
as a controlled operating-system comparison.

[Raw Windows observations](benchmarks/windows-2026-09-15.json) retain timings,
completeness checks, and diagnostic signatures; local installation paths are
omitted. The Windows reviewer used an independent runner with the same warmup,
interleaving, and fresh-process timing method.

## Method and limits

One warmup pair was excluded, followed by five measured runs per version per
scenario. Version order alternated. Each run launched a fresh CLI and language
server, with identical input files and server/Tailwind versions. Timing used an
external monotonic clock from process launch through process completion. Package
installation was outside the timed region, output was captured without a TTY,
and filesystem/package caches were warm.

These are synthetic scan benchmarks, not a promise of the same percentage on
all projects. No claim is made about installation speed, cold filesystem caches,
autofix throughput, peak memory, or Bun-versus-Node speed. Correctness is checked
before reporting an improvement: an incomplete scan is never credited as faster.

## Reproduce

Build and pack the candidate, then create a disposable directory outside the
repository and install both package versions under aliases:

```sh
npm init -y
npm install before@npm:tailwint@1.1.15 \
  after@file:/absolute/path/to/tailwint-1.1.16.tgz \
  @tailwindcss/language-server@0.16.0 tailwindcss@4.0.17
node /absolute/path/to/tailwint/scripts/benchmark.mjs "$PWD" 5
```

Use a supported Node runtime. The runner writes generated fixtures, individual
CLI logs under `evidence/`, and `results.json` into that disposable directory.
It refuses to continue if the candidate returns incomplete results. Use a fresh
directory for each benchmark setup so prior files cannot affect glob results.
