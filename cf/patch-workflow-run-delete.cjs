const fs = require("node:fs");
const path = require("node:path");

const TARGET_FILES = new Set([
  "workflow-run-delete-one.pre-query.hook.js",
  "workflow-run-delete-many.pre-query.hook.js",
]);

function replaceExecuteMethod(source, fileName) {
  const marker = "async execute(";
  const methodStart = source.indexOf(marker);

  if (methodStart === -1) {
    throw new Error(`${fileName}: async execute method not found`);
  }

  const bodyStart = source.indexOf("{", methodStart + marker.length);

  if (bodyStart === -1) {
    throw new Error(`${fileName}: execute method body not found`);
  }

  let depth = 0;
  let quote = null;
  let escaped = false;
  let bodyEnd = -1;

  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];

    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }

    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        bodyEnd = index + 1;
        break;
      }
    }
  }

  if (bodyEnd === -1) {
    throw new Error(`${fileName}: execute method closing brace not found`);
  }

  const originalMethod = source.slice(methodStart, bodyEnd);

  if (
    !originalMethod.includes("Method not allowed.") ||
    !originalMethod.includes("FORBIDDEN")
  ) {
    throw new Error(`${fileName}: refusing to patch an unexpected hook`);
  }

  return (
    source.slice(0, methodStart) +
    "async execute(_authContext, _objectName, payload) {\n        return payload;\n    }" +
    source.slice(bodyEnd)
  );
}

function findTargets(rootDirectory) {
  const targets = [];
  const directories = [rootDirectory];

  while (directories.length > 0) {
    const directory = directories.pop();

    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        directories.push(entryPath);
      } else if (TARGET_FILES.has(entry.name)) {
        targets.push(entryPath);
      }
    }
  }

  return targets;
}

function patchDirectory(rootDirectory) {
  const targets = findTargets(rootDirectory);
  const foundNames = new Set(targets.map((target) => path.basename(target)));

  for (const expectedName of TARGET_FILES) {
    if (!foundNames.has(expectedName)) {
      throw new Error(`${expectedName}: compiled hook not found`);
    }
  }

  for (const target of targets) {
    const source = fs.readFileSync(target, "utf8");
    fs.writeFileSync(
      target,
      replaceExecuteMethod(source, path.basename(target)),
      "utf8",
    );
  }

  return targets;
}

function selfTest() {
  const fixture =
    "class Hook { async execute() {\n" +
    "  throw new WorkflowQueryValidationException(\n" +
    '    "Method not allowed.",\n' +
    "    WorkflowQueryValidationExceptionCode.FORBIDDEN,\n" +
    "  );\n" +
    "} }";
  const patched = replaceExecuteMethod(fixture, "fixture.js");

  if (
    !patched.includes(
      "async execute(_authContext, _objectName, payload)",
    ) ||
    !patched.includes("return payload;") ||
    patched.includes("Method not allowed.")
  ) {
    throw new Error("self-test failed");
  }
}

if (require.main === module) {
  if (process.argv[2] === "--self-test") {
    selfTest();
    process.stdout.write("workflow-run delete patch self-test passed\n");
  } else {
    const rootDirectory =
      process.argv[2] ?? "/app/packages/twenty-server/dist";
    const patchedTargets = patchDirectory(rootDirectory);
    process.stdout.write(
      `patched workflow-run delete hooks:\n${patchedTargets.join("\n")}\n`,
    );
  }
}

module.exports = { findTargets, patchDirectory, replaceExecuteMethod, selfTest };
