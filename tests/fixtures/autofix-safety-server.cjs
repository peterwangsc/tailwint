// Dedicated stdio fixture for autofix safety. Never used by the shared LSP tests.
const { readFileSync, writeFileSync, unlinkSync } = require('node:fs');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { join } = require('node:path');
let buffer = Buffer.alloc(0), root, scenario, uri, text, pass = 0;
const range = (start, end) => ({ start: { line: 0, character: start }, end: { line: 0, character: end } });
const issue = (index = 0) => ({ code: 'cssConflict', severity: 2, message: 'fixture issue', range: range(index, index + 1) });
const edits = (start, end, newText) => ({ range: range(start, end), newText });
function send(message) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function publish(diagnostics) {
  send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
}
function action(changes) { return { title: 'fixture fix', edit: { changes: { [uri]: changes } } }; }
function receive({ id, method, params }) {
  if (method === 'initialize') {
    root = fileURLToPath(params.rootUri);
    scenario = JSON.parse(readFileSync(join(root, 'scenario.json'), 'utf8'));
    send({ id, result: { capabilities: {} } });
  } else if (method === 'textDocument/didOpen') {
    uri = params.textDocument.uri; text = params.textDocument.text;
    publish(Array.from({ length: scenario.issues || 1 }, (_, i) => issue(i)));
  } else if (method === 'textDocument/hover') send({ id, result: null });
  else if (method === '@/tailwindCSS/getProject') send({ id, result: { version: '4.1.0' } });
  else if (method === 'textDocument/codeAction') {
    const index = params.context.diagnostics[0].range.start.character;
    let actions;
    if (scenario.mode === 'cycle') actions = [action([edits(0, text.length, text === 'A' ? 'B' : 'A')])];
    else if (scenario.mode === 'revisit') actions = [action([edits(0, text.length, pass === 0 ? 'B' : pass === 1 ? 'A' : 'C')])];
    else if (scenario.mode === 'noop-alternative') actions = [action([edits(0, text.length, text)]), action([edits(0, text.length, 'fixed')])];
    else if (scenario.mode === 'converge') actions = [action([edits(0, text.length, String(Number(text) + 1))])];
    else if (scenario.mode === 'overlap-actions') actions = [action(index === 0 ? [edits(1, 4, 'X')] : [edits(2, 5, 'Y')])];
    else if (scenario.mode === 'atomic-actions') actions = [action(index === 0 ? [edits(1, 4, 'X'), edits(6, 7, 'Z')] : [edits(2, 5, 'Y')])];
    else if (scenario.mode === 'inserts') actions = [action([edits(1, 1, 'X'), edits(1, 1, 'Y')])];
    else if (scenario.mode === 'invalid') actions = [action(scenario.edits)];
    else if (scenario.mode === 'multi-changes') actions = [{ edit: { changes: { [uri]: [edits(0, text.length, 'fixed')], [pathToFileURL(join(root, 'other.tsx')).href]: [edits(0, 5, 'other fixed')] } } }];
    else if (scenario.mode === 'multi-documentChanges') actions = [{ edit: { documentChanges: [
      { textDocument: { uri, version: 1 }, edits: [edits(0, text.length, 'fixed')] },
      { textDocument: { uri: pathToFileURL(join(root, 'other.tsx')).href, version: null }, edits: [edits(0, 5, 'other fixed')] },
    ] } }];
    else if (scenario.mode === 'resource-operation') actions = [{ edit: { documentChanges: [
      { textDocument: { uri, version: 1 }, edits: [edits(0, text.length, 'fixed')] },
      { kind: 'delete', uri: pathToFileURL(join(root, 'other.tsx')).href },
    ] } }];
    else if (scenario.mode === 'stale-version') actions = [{ edit: { documentChanges: [{ textDocument: { uri, version: 0 }, edits: [edits(0, text.length, 'fixed')] }] } }];
    else if (scenario.mode === 'disabled') actions = [{ ...action([edits(0, text.length, 'fixed')]), disabled: { reason: 'unsafe' } }];
    else if (scenario.mode === 'command') actions = [{ ...action([edits(0, text.length, 'fixed')]), command: { title: 'required followup', command: 'fixture.followup' } }];
    else actions = [action([edits(0, text.length, 'fixed')])];
    if (scenario.alternative) actions.push(action([edits(0, text.length, 'fixed')]));
    send({ id, result: actions });
  } else if (method === 'textDocument/didChange') {
    text = params.contentChanges[0].text; pass++;
    writeFileSync(join(root, 'observed.json'), JSON.stringify({ text, pass }));
    if (scenario.mode === 'stale-disk') writeFileSync(fileURLToPath(uri), 'user edit');
    if (scenario.mode === 'deleted-disk') unlinkSync(fileURLToPath(uri));
    if (scenario.mode === 'cycle') publish([issue()]);
    else if (scenario.mode === 'revisit' && text !== 'C') publish([issue()]);
    else if (scenario.mode === 'converge' && Number(text) < scenario.passes) publish([issue()]);
    else publish([]);
  } else if (method === 'shutdown') send({ id, result: null });
  else if (method === 'exit') process.exit(0);
}
process.stdin.on('data', data => {
  buffer = Buffer.concat([buffer, data]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    receive(message);
  }
});
