import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const assets = resolve(import.meta.dirname, '../frontend/assets');
const targets = [
  [/^getRecordFromCache-.*\.js$/, 'CacheReadFragment'],
  [/^updateRecordFromCache-.*\.js$/, 'CacheWriteFragment'],
];
let patched = 0;
for (const [pattern, suffix] of targets) {
  const file = readdirSync(assets).find((name) => pattern.test(name));
  if (!file) throw new Error(`Missing Twenty cache asset ${pattern}`);
  const path = resolve(assets, file); const source = readFileSync(path, 'utf8');
  const next = source.replace(/fragment \$\{([A-Za-z_$][\w$]*)\}Fragment on \$\{\1\}/, 'fragment ${$1}' + suffix + ' on ${$1}');
  if (next === source && !source.includes(`${suffix} on`)) throw new Error(`Fragment patch did not match ${file}`);
  if (next !== source) { writeFileSync(path, next); patched += 1; }
}
console.log(JSON.stringify({ result: 'passed', patched }));
