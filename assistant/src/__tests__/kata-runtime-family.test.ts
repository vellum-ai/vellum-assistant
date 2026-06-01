import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dir, "../../..");
const runtimeFamilyScript = resolve(
  repoRoot,
  "assistant/docker-kata-runtime-family.sh",
);

function runRuntimePredicate(runtime: string) {
  return Bun.spawnSync({
    cmd: [
      "sh",
      "-c",
      `. "${runtimeFamilyScript}"; VELLUM_SANDBOX_RUNTIME="$1"; vellum_is_kata_family_runtime`,
      "runtime-family-test",
      runtime,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("Kata-family runtime detection", () => {
  test("treats kata, firecracker, and cloud-hypervisor as Kata-family runtimes", () => {
    for (const runtime of ["kata", "firecracker", "cloud-hypervisor"]) {
      expect(runRuntimePredicate(runtime).exitCode).toBe(0);
    }
  });

  test("does not treat other sandbox runtimes as Kata-family runtimes", () => {
    expect(runRuntimePredicate("gvisor").exitCode).not.toBe(0);
    expect(runRuntimePredicate("").exitCode).not.toBe(0);
  });
});
