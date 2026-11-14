import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-expect-error Node build-validation script has no declaration file.
import { checkModuleGraph } from '../scripts/check-twenty-module-graph.mjs';

test('HTML and chunks initialize exactly the same Twenty entry module', async () => {
  const result = await checkModuleGraph();
  expect(result.references).toBeGreaterThan(0);
  expect(result.conflicts).toEqual([]);
}, 30_000);

test('checks static imports, re-exports and literal dynamic imports without counting comments or strings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crm-module-graph-'));
  try {
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), '<script type="module" src="/assets/main.js?v=1"></script>');
    await writeFile(join(directory, 'assets/chunk.js'), [
      'import "./main.js?v=1";',
      'export { value } from "./main.js?v=1";',
      'const load = () => import("./main.js?v=2");',
      '// import "./main.js?comment";',
      'const text = \'import "./main.js?string"\';',
      'const computed = (name) => import(name);',
      'const origin = import.meta.url;',
    ].join('\n'));
    const result = await checkModuleGraph(pathToFileURL(`${directory}/`));
    expect(result.references).toBe(3);
    expect(result.conflicts).toEqual([{ file: 'chunk.js', target: 'https://twenty.example/assets/main.js?v=2' }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
