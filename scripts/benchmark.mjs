// Usage: node scripts/benchmark.mjs <isolated workspace> [measured runs=5]
// The workspace must contain npm aliases `before` and `after`, plus identical
// @tailwindcss/language-server and tailwindcss installations. See docs/PERFORMANCE.md.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';

if (!process.argv[2]) throw new Error('Provide an isolated benchmark workspace.');
const root = resolve(process.argv[2]);
const runs = Number(process.argv[3] ?? 5);
if (!Number.isInteger(runs) || runs < 1) throw new Error('Measured runs must be a positive integer.');
const modules = join(root, 'node_modules');
const pkg = name => JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8'));
const environment = {
  node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
  before: pkg('before').version, after: pkg('after').version,
  server: pkg('@tailwindcss/language-server').version, tailwind: pkg('tailwindcss').version,
};
const cases = [
  { name: 'small-css-tsx', perProject: 2, pattern: '**/*.{tsx,css}' },
  { name: 'large-css-tsx', perProject: 48, pattern: '**/*.{tsx,css}' },
  { name: 'large-tsx-only', perProject: 48, pattern: '**/*.tsx' },
];
mkdirSync(join(root, 'evidence'), { recursive: true });
const observations = [];
for (const scenario of cases) {
  const cwd = join(root, 'fixtures', scenario.name);
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'package.json'), '{"private":true}');
  if (!existsSync(join(cwd, 'node_modules'))) symlinkSync(modules, join(cwd, 'node_modules'), 'junction');
  for (const name of ['a', 'b']) {
    const dir = join(cwd, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app.css'), '@import "tailwindcss";');
    for (let i = 0; i < scenario.perProject; i++) {
      writeFileSync(join(dir, `page-${i}.tsx`), '<div className="w-full w-auto" />\n');
    }
  }
  const expectedFiles = scenario.perProject * 2 + (scenario.pattern.includes('css') ? 2 : 0);
  const expectedIssues = scenario.perProject * 4;
  // One warmup pair, then alternate order to limit cache/order bias. Every
  // observation launches a fresh CLI and language server; installs are untimed.
  for (let round = 0; round <= runs; round++) {
    for (const version of round % 2 ? ['after', 'before'] : ['before', 'after']) {
      const start = performance.now();
      const child = spawnSync(process.execPath, [join(modules, version, 'bin/tailwint.js'), scenario.pattern],
        { cwd, encoding: 'utf8', timeout: 45_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, DEBUG: '0', NO_COLOR: '1' } });
      const milliseconds = performance.now() - start;
      const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
      writeFileSync(join(root, 'evidence', `${scenario.name}-${version}-${round}.log`), output);
      const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
      const received = [...plain.matchAll(/(\d+)\/(\d+) files received/g)].at(-1);
      const issues = plain.match(/FAIL\s+(\d+) issues in (\d+) files/);
      const row = { case: scenario.name, version, round, warmup: round === 0,
        milliseconds, exit: child.status, error: child.error?.message,
        received: received ? Number(received[1]) : null,
        sent: received ? Number(received[2]) : null,
        issues: issues ? Number(issues[1]) : (plain.includes('all clear') ? 0 : null),
        expectedFiles, expectedIssues };
      row.complete = row.exit === 1 && row.received === expectedFiles && row.issues === expectedIssues;
      observations.push(row);
      console.log(JSON.stringify(row));
      writeFileSync(join(root, 'results.json'), JSON.stringify({ environment, observations }, null, 2));
      if (version === 'after' && !row.complete) throw new Error('Candidate benchmark did not produce complete diagnostics; inspect evidence.');
    }
  }
}
