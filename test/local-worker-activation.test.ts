import { expect, test } from "vitest";
import { activateLocalWorkers, type WorkerActivation } from "../src/local-worker-activation.js";

function fixture(failAt?: string) {
  const active = new Set(["sampleapp", "otherapp"]);
  const calls: string[] = [];
  const step = (name: string) => async () => {
    calls.push(name);
    if (name === failAt) throw new Error(`${name} failed`);
    if (name === "stop") active.delete("sampleapp");
    if (name === "activate") active.add("sampleapp");
  };
  const operations: WorkerActivation = {
    stop: step("stop"), secrets: step("secrets"), runtime: step("runtime"),
    schedule: step("schedule"), verify: step("verify"), activate: step("activate")
  };
  return { active, calls, operations };
}

test("workers activate only after secrets, runtime and schedule are verified", async () => {
  const f = fixture();
  await activateLocalWorkers(f.operations);
  expect(f.calls).toEqual(["stop", "secrets", "runtime", "schedule", "verify", "activate"]);
  expect([...f.active].sort()).toEqual(["otherapp", "sampleapp"]);
});

test.each(["secrets", "runtime", "schedule", "verify", "activate"])(
  "a %s failure stops this project's workers without affecting other projects", async step => {
    const f = fixture(step);
    await expect(activateLocalWorkers(f.operations)).rejects.toThrow(`${step} failed`);
    expect(f.active.has("sampleapp")).toBe(false);
    expect(f.active.has("otherapp")).toBe(true);
    expect(f.calls.at(-1)).toBe("stop");
  }
);

test("a failed stop aborts before any configuration or activation", async () => {
  const f = fixture("stop");
  await expect(activateLocalWorkers(f.operations)).rejects.toThrow("stop failed");
  expect(f.calls).toEqual(["stop"]);
});

test("failure to stop after a failed activation reports that safety could not be established", async () => {
  const f = fixture("activate");
  let stops = 0;
  f.operations.stop = async () => { if (++stops > 1) throw new Error("stop failed"); };
  await expect(activateLocalWorkers(f.operations)).rejects.toThrow("Worker reconfiguration and stop failed");
});
