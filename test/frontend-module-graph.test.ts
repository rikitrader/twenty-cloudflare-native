import { expect, test } from 'vitest';
// @ts-expect-error Node build-validation script has no declaration file.
import { checkModuleGraph } from '../scripts/check-twenty-module-graph.mjs';

test('HTML and chunks initialize exactly the same Twenty entry module', async () => {
  const result = await checkModuleGraph();
  expect(result.references).toBeGreaterThan(0);
  expect(result.conflicts).toEqual([]);
}, 30_000);
