import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Run the TypeScript unit suite on the workspace's supported Node 20 runtime.
const source = await readFile(new URL('../test/workbuddy.test.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
