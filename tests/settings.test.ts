import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSettings, getSettingsSection } from '../src/settings.js';

function workspace(t: any, text?: string) {
  const root = mkdtempSync(join(tmpdir(), 'tailwint-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.vscode'));
  if (text !== undefined) writeFileSync(join(root, '.vscode/settings.json'), text);
  return root;
}
const plain = (value: any) => JSON.parse(JSON.stringify(value));

test('JSONC preserves URLs, comment-like strings, escapes, and trailing-comma-like strings', t => {
  const values = {
    'json.schemas': [{ url: 'https://example.com/schema.json' }],
    'tailwindCSS.experimental.classRegex': ['// foo /* bar */ ,}', '\\"class='],
    'tailwindCSS.lint.cssConflict': 'error',
  };
  const text = '\uFEFF{/* block comment */\n// line comment\n' + JSON.stringify(values).slice(1, -1) + ',\n}';
  assert.deepEqual(readSettings(workspace(t, text)), values);
});

test('invalid settings fail explicitly instead of silently restoring default lint rules', t => {
  assert.throws(() => readSettings(workspace(t, '{"tailwindCSS.validate": false, broken}')), /Invalid .*settings.json/);
  for (const value of ['[]', 'null', 'true']) {
    assert.throws(() => readSettings(workspace(t, value)), /expected an object/);
  }
});

test('missing and empty settings use defaults', t => {
  assert.deepEqual(readSettings(workspace(t)), {});
  assert.deepEqual(readSettings(workspace(t, '// no settings yet')), {});
});

test('configuration requests support flat keys, object sections, scalar values, and full settings', () => {
  const settings = {
    tailwindCSS: { lint: { cssConflict: 'warning' }, classAttributes: ['class'] },
    'tailwindCSS.lint.cssConflict': 'error',
    'tailwindCSS.validate': false,
    'tailwindCSS.experimental': null,
    'tailwindCSS.experimental.classRegex': ['class=(.*)'],
  };
  const expected = { lint: { cssConflict: 'error' }, classAttributes: ['class'], validate: false,
    experimental: { classRegex: ['class=(.*)'] } };
  assert.deepEqual(plain(getSettingsSection(settings, 'tailwindCSS')), expected);
  assert.equal(getSettingsSection(settings, 'tailwindCSS.validate'), false);
  assert.deepEqual(plain(getSettingsSection(settings)), { tailwindCSS: expected });
  assert.equal(getSettingsSection(settings, 'missing'), null);
  assert.equal(settings.tailwindCSS.lint.cssConflict, 'warning');
});

test('dotted keys cannot mutate Object.prototype or expose inherited properties', () => {
  const settings = JSON.parse('{"tailwindCSS.__proto__.tailwintPolluted":true,"tailwindCSS.constructor.prototype.tailwintPolluted":true}');
  getSettingsSection(settings, 'tailwindCSS');
  assert.equal(({} as any).tailwintPolluted, undefined);
  assert.equal(getSettingsSection({}, 'constructor'), null);
});

test('real LSP honors lint settings in JSONC containing URLs and block comments', { timeout: 15_000 }, async t => {
  const { run } = await import('../src/index.js');
  const { symlinkSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = workspace(t, `{
    /* VS Code schema URL must not erase the lint rule below. */
    "json.schemas": [{ "url": "https://example.com/schema.json" }],
    "tailwindCSS.lint.cssConflict": "ignore",
  }`);
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(root, 'node_modules'), 'junction');
  writeFileSync(join(root, 'package.json'), '{"private":true}');
  writeFileSync(join(root, 'app.css'), '@import "tailwindcss";');
  writeFileSync(join(root, 'page.tsx'), '<div className="w-full w-auto" />');
  assert.equal(await run({ cwd: root, timeoutMs: 5000 }), 0);
  writeFileSync(join(root, '.vscode/settings.json'), '{bad}');
  assert.equal(await run({ cwd: root, timeoutMs: 5000 }), 2);
});
