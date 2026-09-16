import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { run } from '../src/index.js';

function workspace(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'tailwint-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'node_modules/@tailwindcss/language-server/bin');
  mkdirSync(bin, { recursive: true });
  copyFileSync(fileURLToPath(new URL('fixtures/language-server.cjs', import.meta.url)), join(bin, 'tailwindcss-language-server'));
  writeFileSync(join(root, 'scenario.json'), '{"initDelay":100}');
  return root;
}

test('a concurrent call fails without resetting or shutting down the active run', async t => {
  const cwd = workspace(t);
  writeFileSync(join(cwd, 'page.tsx'), '<div className="w-full w-auto"/>');
  const first = run({ cwd, timeoutMs: 2000 });
  const second = run({ cwd, timeoutMs: 2000 });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.equal(await run({ cwd, patterns: ['missing.tsx'] }), 0);
});

test('invalid timeout values fail and do not poison the next invocation', async t => {
  const cwd = workspace(t);
  for (const timeoutMs of [0, -1, NaN, Infinity, 0.5, 2 ** 31]) {
    assert.equal(await run({ cwd, timeoutMs }), 2);
  }
  assert.equal(await run({ cwd }), 0);
});

test('unreadable selected files fail instead of producing an all-clear scan', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async t => {
  const cwd = workspace(t);
  const path = join(cwd, 'page.tsx');
  writeFileSync(path, '<div/>');
  chmodSync(path, 0);
  try { assert.equal(await run({ cwd }), 2); }
  finally { chmodSync(path, 0o600); }
});

const cli = fileURLToPath(new URL('../bin/tailwint.js', import.meta.url));
test('CLI rejects misspelled options with exit 2', () => {
  const result = spawnSync(process.execPath, [cli, '--fxi'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option --fxi/);
});

test('CLI -- treats option-like filenames literally', t => {
  const cwd = workspace(t);
  writeFileSync(join(cwd, '--help'), '<div/>');
  const result = spawnSync(process.execPath, [cli, '--', '--help'], { cwd, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /sent 1 file/);
});

test('CLI validates timeout and ignore arguments before scanning', () => {
  for (const args of [
    ['--timeout'], ['--timeout', '0'], ['--timeout=-1'], ['--timeout=0.5'],
    ['--timeout=Infinity'], ['--timeout=2147483648'], ['--timeout='],
    ['--timeout', '--fix'], ['--ignore'], ['--ignore='], ['--ignore', '--fix'],
  ]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /requires/);
  }
});

test('CLI timeout reaches the server and allows a longer budget when requested', t => {
  const cwd = workspace(t);
  writeFileSync(join(cwd, 'page.tsx'), '<div/>');
  writeFileSync(join(cwd, 'scenario.json'), '{"initDelay":400}');
  const short = spawnSync(process.execPath, [cli, '--timeout', '150'], { cwd, encoding: 'utf8', timeout: 10_000 });
  assert.equal(short.status, 2, short.stderr);
  assert.match(short.stderr, /Timed out waiting/);
  const long = spawnSync(process.execPath, [cli, '--timeout=3000'], { cwd, encoding: 'utf8', timeout: 10_000 });
  assert.equal(long.status, 1, long.stderr);
});

test('additional ignore patterns exclude generated files through the API and CLI', async t => {
  const cwd = workspace(t);
  writeFileSync(join(cwd, 'page.tsx'), '<div/>');
  for (const dir of ['release', 'generated']) {
    mkdirSync(join(cwd, dir));
    writeFileSync(join(cwd, dir, 'artifact.html'), '<div/>');
  }
  const { diagnosticsReceived, fileUri } = await import('../src/lsp.js');
  assert.equal(await run({ cwd, ignore: ['release/**', 'generated/**'] }), 1);
  assert.deepEqual([...diagnosticsReceived.keys()], [fileUri(join(cwd, 'page.tsx'))]);
  const result = spawnSync(process.execPath, [cli, '--ignore', 'release/**', '--ignore=generated/**'], {
    cwd, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /sent 1 file/);
});
