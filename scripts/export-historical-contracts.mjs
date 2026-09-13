import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(sdkRoot, '..');
const source = await readFile(resolve(sdkRoot, 'src/historical/contracts.ts'), 'utf8');
const hash = createHash('sha256').update(source).digest('hex');
const generated = `// Generated from nuberea-sdk/src/historical/contracts.ts. Do not edit.\n// Source SHA-256: ${hash}\n${source}`;
const header = `// Generated from nuberea-sdk/src/historical/contracts.ts. Do not edit.\n// Source SHA-256: ${hash}\n`;
const javascript = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const targets = [
  ['nuberea-mcp-auth/src/core/historical/contracts.generated.ts', generated],
  ['nuberea-chat-api/src/core/historical/contracts.generated.ts', generated],
  ['nuberea-web/src/lib/network/contracts.generated.ts', generated],
  ['nuberea-chat-api/src/harness/runtime/historicalContracts.generated.mjs', header + javascript],
];
const check = process.argv.includes('--check');
let failed = false;

for (const [target, expected] of targets) {
  const destination = resolve(workspace, target);
  if (check) {
    let actual;
    try {
      actual = await readFile(destination, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (actual !== expected) {
      console.error(`Historical contracts are out of date: ${target}`);
      failed = true;
    }
  } else {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, expected, 'utf8');
    console.log(`Generated ${target}`);
  }
}

if (failed) process.exitCode = 1;
