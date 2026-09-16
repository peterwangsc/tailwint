import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/index.js';
import { startServer, resetState, send, shutdown, fileUri } from '../src/lsp.js';

function workspace(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'tailwint-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('finds a language server hoisted above the working directory without PATH', async t => {
  const root = workspace(t);
  const project = join(root, 'packages', 'app');
  const bin = join(root, 'node_modules/@tailwindcss/language-server/bin');
  mkdirSync(project, { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(fileURLToPath(new URL('fixtures/language-server.cjs', import.meta.url)), join(bin, 'tailwindcss-language-server'));
  writeFileSync(join(project, 'scenario.json'), '{}');
  writeFileSync(join(project, 'page.tsx'), '<div className="w-full w-auto" />');
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = '';
    assert.equal(await run({ cwd: project, patterns: ['*.tsx'], timeoutMs: 1000 }), 1);
  } finally { process.env.PATH = originalPath; }
});

test('falls back to the package peer installation for programmatic callers', async t => {
  const root = workspace(t);
  const originalPath = process.env.PATH;
  resetState();
  try {
    process.env.PATH = '';
    startServer(root);
    const result = await send('initialize', {
      rootUri: fileUri(root), capabilities: { workspace: { configuration: true } },
    }, 5000);
    assert.ok(result.capabilities);
  } finally {
    await shutdown();
    process.env.PATH = originalPath;
  }
});
