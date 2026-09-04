"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FRONT_ROOT = "/app/packages/twenty-server/dist/front/assets";
const PATCH_VARIANTS = [
  {
    version: "v2.20",
    needle: "Ze=(0,C.useCallback)(()=>{XTe(),P()},[P])",
    replacement:
      'Ze=(0,C.useCallback)(async()=>{try{const _t=JSON.parse(localStorage.getItem("tokenPairState")||"null")?.accessOrWorkspaceAgnosticToken?.token;_t&&await fetch("/_auth/revoke",{method:"POST",headers:{authorization:`Bearer ${_t}`}})}catch{}XTe(),P()},[P])',
  },
  {
    version: "v2.24.1",
    needle: "Qe=(0,E.useCallback)(()=>{gAe(),P()},[P])",
    replacement:
      'Qe=(0,E.useCallback)(async()=>{try{const _t=JSON.parse(localStorage.getItem("tokenPairState")||"null")?.accessOrWorkspaceAgnosticToken?.token;_t&&await fetch("/_auth/revoke",{method:"POST",headers:{authorization:`Bearer ${_t}`}})}catch{}gAe(),P()},[P])',
  },
];

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(file));
    else if (entry.isFile() && file.endsWith(".js")) files.push(file);
  }
  return files;
}

function patchRoot(root) {
  const matches = [];
  for (const file of walk(root)) {
    const source = fs.readFileSync(file, "utf8");
    for (const variant of PATCH_VARIANTS) {
      if (!source.includes(variant.needle)) continue;
      if (source.includes("/_auth/revoke")) {
        matches.push({ file, version: variant.version });
        continue;
      }
      const updated = source.replace(variant.needle, variant.replacement);
      if (updated === source) throw new Error(`failed to patch ${file}`);
      fs.writeFileSync(file, updated);
      matches.push({ file, version: variant.version });
    }
  }
  if (matches.length !== 1)
    throw new Error(`expected exactly one auth bundle, found ${matches.length}`);
  return matches[0];
}

function selfTest() {
  for (const variant of PATCH_VARIANTS) {
    const fixture = `const ${variant.needle};`;
    const updated = fixture.replace(variant.needle, variant.replacement);
    if (
      !updated.includes("/_auth/revoke") ||
      !updated.includes("async()=>") ||
      updated.includes(variant.needle)
    )
      throw new Error(
        `frontend auth revocation patch self-test failed for ${variant.version}`,
      );
  }
  console.log("Frontend auth revocation patch self-test passed");
}

if (process.argv.includes("--self-test")) selfTest();
else {
  if (!fs.existsSync(FRONT_ROOT)) throw new Error(`frontend assets missing: ${FRONT_ROOT}`);
  const match = patchRoot(FRONT_ROOT);
  console.log(`Patched ${match.file} (${match.version})`);
}

module.exports = { PATCH_VARIANTS, patchRoot };
