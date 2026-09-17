import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// The main bundle exports atoms AND mounts React. Loading it with two URLs
// initializes two applications even when both responses contain identical bytes.
export async function checkModuleGraph(root = new URL('../frontend/', import.meta.url)) {
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
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
    const visit = (node) => {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? node.arguments[0] : undefined;
      if (specifier && ts.isStringLiteral(specifier)) {
        const target = new URL(specifier.text, `${origin}/assets/${file}`);
        if (target.pathname === entry.pathname) {
          references++;
          if (target.href !== entry.href) conflicts.push({ file, target: target.href });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return { entry: entry.href, references, conflicts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkModuleGraph();
  console.log(JSON.stringify({ ...result, conflicts: result.conflicts.slice(0, 5), conflictCount: result.conflicts.length }, null, 2));
  if (!result.references || result.conflicts.length) process.exitCode = 1;
}
