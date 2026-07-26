import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("container outbound registration", () => {
  const source = readFileSync(resolve("src/containers.ts"), "utf8");

  it("uses the Containers SDK static setter instead of shadowing it", () => {
    expect(source).not.toMatch(/static\s+outboundByHost\s*=/);
    for (const className of ["TwentyServer", "TwentyWorker"]) {
      expect(source).toContain(`${className}.outboundByHost = stateOutbound`);
    }
  });
});
