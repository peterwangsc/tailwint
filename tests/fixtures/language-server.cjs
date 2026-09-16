// A deterministic JSON-RPC server for exercising the client over real stdio.
const { readFileSync } = require('node:fs');
const { fileURLToPath } = require('node:url');
const { join } = require('node:path');
let buffer = Buffer.alloc(0);
let scenario;
const documents = [];
const publish = (uri, diagnostics = []) => send({
  method: 'textDocument/publishDiagnostics', params: { uri, diagnostics },
});
const issue = {
  code: 'cssConflict', severity: 2, message: 'conflicting classes',
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
};
function send(message) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
function receive(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    scenario = JSON.parse(readFileSync(join(fileURLToPath(params.rootUri), 'scenario.json')));
    send({ id, result: { capabilities: {} } });
  } else if (method === 'textDocument/didOpen') {
    const uri = params.textDocument.uri;
    const index = documents.push(uri) - 1;
    // Several projects may initialize in quick succession. This is not failure.
    send({ method: '@/tailwindCSS/projectInitialized' });
    if (!scenario.missing && !scenario.noProject) {
      setTimeout(() => publish(uri, index === 0 && !scenario.clean ? [issue] : []),
        scenario.delays?.[index] ?? 10);
    }
  } else if (method === 'textDocument/hover') {
    if (scenario.crash) return setTimeout(() => process.exit(7), 20);
    if (!scenario.hang) setTimeout(() => send({ id, result: null }), scenario.initDelay ?? 20);
  } else if (method === '@/tailwindCSS/getProject') {
    send({ id, result: scenario.noProject ? null : { version: '4.1.0' } });
  } else if (method === 'textDocument/codeAction') {
    if (scenario.actionError) return send({ id, error: { code: -32603, message: 'action failed' } });
    send({ id, result: [{ edit: { changes: {
      [params.textDocument.uri]: [{ range: issue.range, newText: 'fixed' }],
    } } }] });
  } else if (method === 'textDocument/didChange') {
    if (!scenario.fixMissing) publish(params.textDocument.uri);
  } else if (method === 'shutdown') {
    send({ id, result: null });
  } else if (method === 'exit') {
    process.exit(0);
  }
}
process.stdin.on('data', (data) => {
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
