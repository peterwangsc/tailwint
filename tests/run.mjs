import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Expand filenames here: Windows shells and Node 18 do not expand test globs.
const tests = readdirSync(new URL('.', import.meta.url))
  .filter(name => name.endsWith('.test.ts'))
  .map(name => fileURLToPath(new URL(name, import.meta.url)));
const cli = createRequire(import.meta.url).resolve('tsx/cli');
const result = spawnSync(process.execPath, [cli, '--test', ...tests], { stdio: 'inherit' });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
