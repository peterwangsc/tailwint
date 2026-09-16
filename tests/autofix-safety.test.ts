import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixFile } from '../src/edits.js';
import { resetState, startServer, send, notify, shutdown, fileUri, waitForDiagnostics, diagnosticsReceived } from '../src/lsp.js';

// Separate test process and fixture: the LSP client is module-global.
async function connect(t: any, scenario: object, text = 'abcdefghi') {
  const root = mkdtempSync(join(tmpdir(), 'tailwint-autofix-'));
  t.after(async () => { await shutdown(); rmSync(root, { recursive: true, force: true }); });
  const bin = join(root, 'node_modules/@tailwindcss/language-server/bin');
  mkdirSync(bin, { recursive: true });
  copyFileSync(fileURLToPath(new URL('./fixtures/autofix-safety-server.cjs', import.meta.url)), join(bin, 'tailwindcss-language-server'));
  writeFileSync(join(root, 'scenario.json'), JSON.stringify(scenario));
  const path = join(root, 'page.tsx');
  writeFileSync(path, text); writeFileSync(join(root, 'other.tsx'), 'other');
  resetState(); startServer(root);
  await send('initialize', { rootUri: fileUri(root) });
  notify('initialized', {});
  const uri = fileUri(path);
  notify('textDocument/didOpen', { textDocument: { uri, languageId: 'typescriptreact', version: 1, text } });
  await waitForDiagnostics([uri], 1000);
  const contents = new Map([[path, text]]), versions = new Map([[path, 1]]);
  return { root, path, text, contents, versions, fix: (onPass?: (pass: number) => void) => fixFile(path, diagnosticsReceived.get(uri)!, contents, versions, onPass, 1000) };
}

const edit = (start: number, end: number, newText = 'X') => ({ range: { start: { line: 0, character: start }, end: { line: 0, character: end } }, newText });
for (const [name, edits] of [
  ['reversed range', [edit(5, 2)]],
  ['negative position', [edit(-1, 2)]],
  ['fractional position', [edit(1.5, 2)]],
  ['position on a missing line', [{ ...edit(0, 1), range: { start: { line: 5, character: 0 }, end: { line: 5, character: 1 } } }]],
  ['missing replacement text', [{ range: edit(0, 1).range }]],
  ['overlap inside one action', [edit(1, 4), edit(2, 5, 'Y')]],
] as const) {
  test(`autofix rejects ${name} before publishing or writing corrupted text`, async t => {
    const f = await connect(t, { mode: 'invalid', edits });
    await assert.rejects(f.fix(), /edit|range|position/i);
    assert.equal(readFileSync(f.path, 'utf8'), f.text);
    assert.equal(existsSync(join(f.root, 'observed.json')), false);
  });
}

test('a character beyond the line is clamped without deleting subsequent lines', async t => {
  const f = await connect(t, { mode: 'invalid', edits: [edit(0, 100)] }, 'abc\nkeep');
  await f.fix();
  assert.equal(readFileSync(f.path, 'utf8'), 'X\nkeep');
});

test('autofix understands bare CR line boundaries', async t => {
  const replacement = { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: 'new' };
  const f = await connect(t, { mode: 'invalid', edits: [replacement] }, 'keep\rold');
  await f.fix();
  assert.equal(readFileSync(f.path, 'utf8'), 'keep\rnew');
});

test('partially overlapping actions are not combined into corrupted text', async t => {
  const f = await connect(t, { mode: 'overlap-actions', issues: 2 });
  assert.deepEqual(await f.fix(), { initial: 2, remaining: 0 });
  assert.ok(['aXefghi', 'abYfghi'].includes(readFileSync(f.path, 'utf8')));
});

test('an action with companion edits is applied as a whole or deferred as a whole', async t => {
  const f = await connect(t, { mode: 'atomic-actions', issues: 2 });
  await f.fix();
  assert.ok(['aXefZhi', 'abYfghi'].includes(readFileSync(f.path, 'utf8')));
});

test('ordered insertions at the same position in one action are all retained', async t => {
  const f = await connect(t, { mode: 'inserts' }, 'ac');
  await f.fix();
  assert.equal(readFileSync(f.path, 'utf8'), 'aXYc');
});

test('oscillating fixes fail without an arbitrary pass limit or a disk write', async t => {
  const f = await connect(t, { mode: 'cycle' }, 'A');
  // Bound the reproduction even before cycle detection exists.
  await assert.rejects(f.fix(pass => { if (pass > 6) throw new Error('reproduction guard: cycle was not detected'); }), /cycle/i);
  const observed = JSON.parse(readFileSync(join(f.root, 'observed.json'), 'utf8'));
  assert.ok(observed.pass < 6, `cycle not stopped: ${observed.pass} changes`);
  assert.equal(readFileSync(f.path, 'utf8'), 'A');
});

test('64 convergent passes remain allowed and fix counts represent diagnostics', async t => {
  const f = await connect(t, { mode: 'converge', passes: 64, issues: 3 }, '0');
  assert.deepEqual(await f.fix(), { initial: 3, remaining: 0 });
  assert.equal(readFileSync(f.path, 'utf8'), '64');
});

test('a convergent run may revisit earlier text when its next fix is different', async t => {
  const f = await connect(t, { mode: 'revisit' }, 'A');
  assert.deepEqual(await f.fix(), { initial: 1, remaining: 0 });
  assert.equal(readFileSync(f.path, 'utf8'), 'C');
});

test('a no-op action does not hide a usable alternative', async t => {
  const f = await connect(t, { mode: 'noop-alternative' });
  assert.deepEqual(await f.fix(), { initial: 1, remaining: 0 });
  assert.equal(readFileSync(f.path, 'utf8'), 'fixed');
});

for (const mode of ['stale-disk', 'deleted-disk']) {
  test(`autofix preserves a concurrent ${mode} change`, async t => {
    const f = await connect(t, { mode });
    await assert.rejects(f.fix());
    if (mode === 'stale-disk') assert.equal(readFileSync(f.path, 'utf8'), 'user edit');
    else assert.equal(existsSync(f.path), false);
    assert.equal(f.contents.get(f.path), f.text);
  });
}

for (const mode of ['multi-changes', 'multi-documentChanges', 'resource-operation', 'disabled', 'command']) {
  test(`unsupported ${mode} action is not partially applied or counted as fixed`, async t => {
    const f = await connect(t, { mode });
    assert.deepEqual(await f.fix(), { initial: 1, remaining: 1 });
    assert.equal(readFileSync(f.path, 'utf8'), f.text);
    assert.equal(readFileSync(join(f.root, 'other.tsx'), 'utf8'), 'other');
  });
}

test('a supported alternative can be used after a multi-document action', async t => {
  const f = await connect(t, { mode: 'multi-changes', alternative: true });
  assert.deepEqual(await f.fix(), { initial: 1, remaining: 0 });
  assert.equal(readFileSync(f.path, 'utf8'), 'fixed');
  assert.equal(readFileSync(join(f.root, 'other.tsx'), 'utf8'), 'other');
});

test('stale versioned document edits fail without changing disk', async t => {
  const f = await connect(t, { mode: 'stale-version' });
  await assert.rejects(f.fix(), /version|stale/i);
  assert.equal(readFileSync(f.path, 'utf8'), f.text);
});
