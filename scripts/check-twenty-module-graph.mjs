import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { init, parse } from 'es-module-lexer/minimal';

// The main bundle exports atoms AND mounts React. Loading it with two URLs
// initializes two applications even when both responses contain identical bytes.
export async function checkModuleGraph(root = new URL('../frontend/', import.meta.url)) {
  await init();
  const html = await readFile(new URL('index.html', root), 'utf8');
  const src = html.match(/<script\b[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
  if (!src) throw new Error('Missing module entry in index.html');
  const origin = 'https://twenty.example';
  const entry = new URL(src, origin);
  const conflicts = [];
  let references = 0;
  for (const file of await readdir(new URL('assets/', root))) {
    if (!file.endsWith('.js')) continue;
    const source = await readFile(new URL(`assets/${file}`, root), 'utf8');
    if (!source.includes(entry.pathname.split('/').at(-1))) continue;
    // Use a module lexer rather than the removed TypeScript 5 compiler API.
    // Literal dynamic imports and re-exports are included; import.meta and
    // computed imports have no resolved name and are not static references.
    const [imports] = parse(source);
    for (const specifier of imports) {
      if (typeof specifier.n === 'string') {
        const target = new URL(specifier.n, `${origin}/assets/${file}`);
        if (target.pathname === entry.pathname) {
          references++;
          if (target.href !== entry.href) conflicts.push({ file, target: target.href });
        }
      }
    }
  }
  return { entry: entry.href, references, conflicts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkModuleGraph();
  console.log(JSON.stringify({ ...result, conflicts: result.conflicts.slice(0, 5), conflictCount: result.conflicts.length }, null, 2));
  if (!result.references || result.conflicts.length) process.exitCode = 1;
}
