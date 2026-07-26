import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("canary fault injection boundary", () => {
  const driver = readFileSync(
    resolve("cf/cloudflare-adapters/queue-driver.cjs"),
    "utf8",
  );
  const production = readFileSync(resolve("wrangler.jsonc"), "utf8");
  const canary = readFileSync(resolve("wrangler.canary.jsonc"), "utf8");
  const state = readFileSync(
    resolve("src/cloudflare-state/state-do.ts"),
    "utf8",
  );
  const worker = readFileSync(resolve("src/index.ts"), "utf8");
  const jobCanary = readFileSync(
    resolve("scripts/run-job-fault-canary.mjs"),
    "utf8",
  );

  it("requires the container-only canary flag before destructive scenarios", () => {
    const guard = driver.indexOf(
      'process.env.CLOUDFLARE_CANARY_MODE !== "true"',
    );
    const crash = driver.indexOf('job.jobName === "crash"');
    const exit = driver.indexOf("process.exit(86)");
    expect(guard).toBeGreaterThan(-1);
    expect(crash).toBeGreaterThan(guard);
    expect(exit).toBeGreaterThan(crash);
  });

  it("destroys the whole worker container only after the hold handler starts", () => {
    const guard = driver.indexOf(
      'process.env.CLOUDFLARE_CANARY_MODE !== "true"',
    );
    const scenario = driver.indexOf(
      'job.jobName === "full-container-crash"',
    );
    const signal = driver.indexOf("await this.signalCanaryJobStarted(job)");
    const hold = driver.indexOf("FULL_CONTAINER_CRASH_HOLD_MS", signal);
    const observed = jobCanary.indexOf("/_canary/job-started");
    const destroy = jobCanary.indexOf("/_canary/restart-worker", observed);
    expect(scenario).toBeGreaterThan(guard);
    expect(signal).toBeGreaterThan(scenario);
    expect(hold).toBeGreaterThan(signal);
    expect(observed).toBeGreaterThan(-1);
    expect(destroy).toBeGreaterThan(observed);
  });

  it("atomically quarantines an expired execution lease before replay", () => {
    expect(state).toContain(
      "failure_code = 'executor-outcome-ambiguous'",
    );
    expect(state).toContain('disposition: "quarantined"');
  });

  it("distinguishes reserved delivery from started handler execution", () => {
    expect(state).toContain(
      "CHECK(status IN ('reserved', 'running', 'completed', 'quarantined'))",
    );
    expect(state).toContain("async markJobExecutionStarted");
    expect(state).toContain("async abandonReservedJobExecution");
    expect(driver).toContain("await this.markJobExecutionStarted");
    expect(driver).toContain('"x-twenty-execution-outcome": "not-started"');
  });

  it("retires the legacy singleton before warming a named worker pool", () => {
    const restart = worker.indexOf(
      'url.pathname === "/_canary/restart-worker"',
    );
    const legacy = worker.indexOf('...(replicas > 1 ? ["main"] : [])', restart);
    const named = worker.indexOf("`instance-${index}`", legacy);
    expect(restart).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(restart);
    expect(named).toBeGreaterThan(legacy);
  });

  it("counts an injected side effect before returning an ambiguous failure", () => {
    const scenario = driver.indexOf(
      'job.jobName === "fail-after-side-effect"',
    );
    const effect = driver.indexOf(
      "await this.recordCanarySideEffect(job)",
      scenario,
    );
    const failure = driver.indexOf(
      'throw new Error("injected failure after side effect")',
      effect,
    );
    expect(scenario).toBeGreaterThan(-1);
    expect(effect).toBeGreaterThan(scenario);
    expect(failure).toBeGreaterThan(effect);
    expect(jobCanary).toContain("sideEffectCount: 1");
  });

  it("enables canary mode only in the isolated Worker configuration", () => {
    expect(canary).toContain('"CANARY_MODE": "true"');
    expect(production).not.toContain('"CANARY_MODE": "true"');
  });

  it("fails closed before exposing physical state diagnostics", () => {
    const method = state.indexOf("async diagnosticsForCanary");
    const guard = state.indexOf(
      'if (!this.canaryMode) throw new Error("canary diagnostics disabled")',
      method,
    );
    expect(method).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(method);
  });
});
