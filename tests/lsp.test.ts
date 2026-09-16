import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/index.js';
import { resetState, startServer, send, notify, shutdown, fileUri, normUri, waitForDiagnostics, diagnosticsReceived } from '../src/lsp.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const issueText = '<div className="w-full w-auto flex-shrink-0 z-[1]" />';

function workspace(t: any, scenario: object, real = false) {
  const root = mkdtempSync(join(tmpdir(), 'tailwint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{"private":true}');
  writeFileSync(join(root, 'scenario.json'), JSON.stringify(scenario));
  if (real) {
    symlinkSync(process.env.TAILWINT_TEST_NODE_MODULES || join(repo, 'node_modules'), join(root, 'node_modules'), 'junction');
  } else {
    const bin = join(root, 'node_modules/@tailwindcss/language-server/bin');
    mkdirSync(bin, { recursive: true });
    copyFileSync(join(repo, 'tests/fixtures/language-server.cjs'), join(bin, 'tailwindcss-language-server'));
  }
  return root;
}

async function connect(root: string, names: string[]) {
  resetState();
  startServer(root);
  await send('initialize', { rootUri: fileUri(root) });
  notify('initialized', {});
  const uris = names.map(name => fileUri(join(root, name)));
  for (const uri of uris) notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'typescriptreact', version: 1, text: issueText },
  });
  return uris;
}

// These tests must remain sequential: the public API supports sequential runs.
test('waits across long diagnostic gaps and rapid project initialization events', async t => {
  const root = workspace(t, { delays: [20, 800, 1400] });
  const uris = await connect(root, ['one.tsx', 'two.tsx', 'three.tsx']);
  try {
    await waitForDiagnostics(uris, 3000);
    assert.equal(diagnosticsReceived.size, 3);
    assert.equal(diagnosticsReceived.get(uris[0])?.length, 1);
  } finally { await shutdown(); }
});

test('keeps diagnostics that arrive before initialization completes', async t => {
  const root = workspace(t, { delays: [10], initDelay: 100 });
  const uris = await connect(root, ['page.tsx']);
  try {
    await waitForDiagnostics(uris, 500);
    assert.equal(diagnosticsReceived.get(uris[0])?.length, 1);
  } finally { await shutdown(); }
});

for (const [name, scenario, expected] of [
  ['missing diagnostics', { missing: true }, /Timed out waiting for diagnostics/],
  ['stalled initialization', { hang: true }, /Timed out waiting for textDocument\/hover/],
  ['server crash', { crash: true, missing: true }, /exited with code 7/],
  ['disabled project', { noProject: true }, /No initialized Tailwind project/],
] as const) {
  test(`${name} rejects instead of declaring a clean scan`, async t => {
    const root = workspace(t, scenario);
    const uris = await connect(root, ['page.tsx']);
    try { await assert.rejects(waitForDiagnostics(uris, 150), expected); }
    finally { await shutdown(); }
  });
}

test('TSX-only patterns wait for diagnostics and sequential runs stay independent', async t => {
  const root = workspace(t, { delays: [100] });
  writeFileSync(join(root, 'page.tsx'), issueText);
  assert.equal(await run({ cwd: root, patterns: ['*.tsx'], timeoutMs: 1000 }), 1);
  writeFileSync(join(root, 'scenario.json'), JSON.stringify({ clean: true }));
  assert.equal(await run({ cwd: root, patterns: ['*.tsx'], timeoutMs: 1000 }), 0);
});

for (const pattern of [
  'src\\nested folder\\100% # café.tsx',
  'src\\**\\*.tsx',
  'src/nested folder\\100% # café.tsx',
]) {
  test(`Windows path pattern scans the intended file: ${pattern}`, { skip: process.platform !== 'win32' }, async t => {
    const root = workspace(t, {});
    const dir = join(root, 'src', 'nested folder');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, '100% # café.tsx');
    writeFileSync(path, issueText);
    writeFileSync(join(root, 'outside.tsx'), issueText);
    assert.equal(await run({ cwd: root, patterns: [pattern], timeoutMs: 1000 }), 1);
    assert.equal(diagnosticsReceived.size, 1);
    assert.equal(diagnosticsReceived.get(fileUri(path))?.length, 1);
  });
}

test('POSIX path patterns preserve backslash escaping of glob characters', { skip: process.platform === 'win32' }, async t => {
  const root = workspace(t, {});
  mkdirSync(join(root, 'src'));
  const path = join(root, 'src', 'literal[1].tsx');
  writeFileSync(path, issueText);
  writeFileSync(join(root, 'src', 'literal1.tsx'), issueText);
  assert.equal(await run({ cwd: root, patterns: ['src/literal\\[1\\].tsx'], timeoutMs: 1000 }), 1);
  assert.equal(diagnosticsReceived.size, 1);
  assert.equal(diagnosticsReceived.get(fileUri(path))?.length, 1);
});

for (const [name, scenario] of [
  ['missing initial diagnostics', { missing: true }],
  ['server crash', { crash: true, missing: true }],
  ['disabled project', { noProject: true }],
  ['missing post-fix diagnostics', { fixMissing: true }],
  ['failed code action', { actionError: true }],
] as const) {
  test(`run returns exit 2 for ${name} and leaves files untouched`, async t => {
    const root = workspace(t, scenario);
    const path = join(root, 'page.tsx');
    writeFileSync(path, issueText);
    assert.equal(await run({ cwd: root, fix: true, patterns: ['*.tsx'], timeoutMs: 150 }), 2);
    assert.equal(readFileSync(path, 'utf8'), issueText);
  });
}

test('file URIs preserve percent, hash, spaces, Unicode, and Windows drive equivalence', () => {
  const path = resolve(tmpdir(), '100% # café.tsx');
  const expectedPath = process.platform === 'win32'
    ? path.replace(/^[A-Z]:/, drive => drive.toLowerCase()) : path;
  assert.equal(fileURLToPath(fileUri(path)), expectedPath);
  assert.equal(normUri(fileUri(path)), fileUri(path));
  assert.equal(normUri('file:///C%3A/Users/Test%20File.tsx'), 'file:///c:/Users/Test%20File.tsx');
  assert.equal(normUri('file:///c:/Users/Test%20File.tsx'), 'file:///c:/Users/Test%20File.tsx');
});

test('real language server scans 96 TSX files across two projects, without CSS in the pattern', { timeout: 30_000 }, async t => {
  const root = workspace(t, {}, true);
  for (const project of ['a', 'b']) {
    const dir = join(root, project);
    mkdirSync(dir);
    writeFileSync(join(dir, 'app.css'), '@import "tailwindcss";');
    for (let i = 0; i < 48; i++) writeFileSync(join(dir, `page-${i}.tsx`), issueText);
  }
  assert.equal(await run({ cwd: root, patterns: ['**/*.tsx'], timeoutMs: 15_000 }), 1);
  for (const project of ['a', 'b']) for (let i = 0; i < 48; i++) {
    const diagnostics = diagnosticsReceived.get(fileUri(join(root, project, `page-${i}.tsx`)));
    assert.ok(diagnostics?.some(d => d.code === 'cssConflict'));
  }
});

test('real language server fixes a file with reserved characters and rescans cleanly', { timeout: 30_000 }, async t => {
  const root = workspace(t, {}, true);
  writeFileSync(join(root, 'app.css'), '@import "tailwindcss";');
  const path = join(root, '100% # café.tsx');
  writeFileSync(path, issueText);
  assert.equal(await run({ cwd: root, patterns: ['*.tsx'], fix: true, timeoutMs: 10_000 }), 0);
  assert.notEqual(readFileSync(path, 'utf8'), issueText);
  assert.equal(await run({ cwd: root, patterns: ['*.tsx'], timeoutMs: 10_000 }), 0);
});
