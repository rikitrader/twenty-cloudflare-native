"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FRONT_ROOT = "/app/packages/twenty-server/dist/front/assets";
const NEEDLE = "Ze=(0,C.useCallback)(()=>{XTe(),P()},[P])";
const REPLACEMENT =
  'Ze=(0,C.useCallback)(async()=>{try{const _t=JSON.parse(localStorage.getItem("tokenPairState")||"null")?.accessOrWorkspaceAgnosticToken?.token;_t&&await fetch("/_auth/revoke",{method:"POST",headers:{authorization:`Bearer ${_t}`}})}catch{}XTe(),P()},[P])';

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
    if (!source.includes(NEEDLE)) continue;
    if (source.includes("/_auth/revoke")) {
      matches.push(file);
      continue;
    }
    const updated = source.replace(NEEDLE, REPLACEMENT);
    if (updated === source) throw new Error(`failed to patch ${file}`);
    fs.writeFileSync(file, updated);
    matches.push(file);
  }
  if (matches.length !== 1)
    throw new Error(`expected exactly one auth bundle, found ${matches.length}`);
  return matches[0];
}

function selfTest() {
  const fixture = `const Ze=(0,C.useCallback)(()=>{XTe(),P()},[P]);`;
  if (!fixture.includes(NEEDLE)) throw new Error("fixture drift");
  const updated = fixture.replace(NEEDLE, REPLACEMENT);
  if (!updated.includes("/_auth/revoke") || !updated.includes("XTe(),P()"))
    throw new Error("frontend auth revocation patch self-test failed");
  console.log("Frontend auth revocation patch self-test passed");
}

if (process.argv.includes("--self-test")) selfTest();
else {
  if (!fs.existsSync(FRONT_ROOT)) throw new Error(`frontend assets missing: ${FRONT_ROOT}`);
  console.log(`Patched ${patchRoot(FRONT_ROOT)}`);
}

module.exports = { NEEDLE, REPLACEMENT, patchRoot };
