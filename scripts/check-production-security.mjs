import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
// The production config uses JSONC comments only; remove comments while
// preserving URL strings (a regex would corrupt https:// values).
function stripJsonComments(input) {
  let output = "";
  let quoted = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        output += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      output += char;
    } else if (char === "/" && next === "/") {
      lineComment = true;
      i += 1;
    } else if (char === "/" && next === "*") {
      blockComment = true;
      i += 1;
    } else {
      output += char;
    }
  }
  return output;
}
const json = stripJsonComments(source);
const config = JSON.parse(json);
const vars = config.vars ?? {};
const failures = [];

if (vars.REDIS_BACKEND !== "cloudflare")
  failures.push("vars.REDIS_BACKEND must be cloudflare");
if (vars.ACCESS_REQUIRED !== "true")
  failures.push("vars.ACCESS_REQUIRED must be true");
if (
  typeof vars.ACCESS_TEAM_DOMAIN !== "string" ||
  !vars.ACCESS_TEAM_DOMAIN.startsWith("https://")
)
  failures.push("vars.ACCESS_TEAM_DOMAIN must be an HTTPS Cloudflare Access issuer");
if (
  typeof vars.ACCESS_AUD !== "string" ||
  vars.ACCESS_AUD.length < 32 ||
  vars.ACCESS_AUD.includes("CHANGE")
)
  failures.push("vars.ACCESS_AUD must be the production Access application audience");
if (Object.prototype.hasOwnProperty.call(vars, "REDIS_URL"))
  failures.push("REDIS_URL must not be present in plaintext production vars");
if (config.observability?.enabled !== true)
  failures.push("observability.enabled must be true");

const result = {
  config: "wrangler.jsonc",
  checkedAt: new Date().toISOString(),
  result: failures.length === 0 ? "passed" : "failed",
  failures,
};
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) process.exitCode = 1;
