/**
 * Guards over the schedule worker entrypoint's feature flag bootstrap.
 *
 * The override cache is process-local, so this worker has to populate its own.
 * When it does not, every flag check inside it resolves to the registry default
 * and ignores remote values and local overrides, and this is the process that
 * decides at fire time whether a schedule runs. The entrypoint installs signal
 * handlers and calls `process.exit`, so it cannot be imported into a test
 * process; these assertions read its source the same way
 * `src/__tests__/worker-entrypoint-guards.test.ts` does.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const INIT_CALL = "await initFeatureFlagOverrides(";
const REFRESH_CALL = "refreshOverridesFromGateway(";
const REFRESH_INTERVAL = "FLAG_REFRESH_INTERVAL_MS";

/** The worker's first call that can execute a schedule. */
const WORK_START = "void tick()";

function readWorkerSource(): string {
  return readFileSync(join(process.cwd(), "src/schedule/worker.ts"), "utf8");
}

describe("schedule worker feature flags", () => {
  test("loads flag overrides before the first schedule tick", () => {
    const source = readWorkerSource();
    const initAt = source.indexOf(INIT_CALL);
    const workAt = source.indexOf(WORK_START);

    expect(
      initAt,
      `The schedule worker must \`${INIT_CALL})\` at startup. Without it ` +
        "its process-local override cache stays unset and fire-time flag " +
        "checks fall back to registry defaults.",
    ).toBeGreaterThanOrEqual(0);
    expect(workAt).toBeGreaterThanOrEqual(0);
    expect(
      initAt < workAt,
      "The flag load must complete before the first tick, so the schedules " +
        "that tick fires are gated on real flag values.",
    ).toBe(true);
  });

  test("re-reads the flag cache on a timer while running", () => {
    const source = readWorkerSource();

    expect(
      source.includes(REFRESH_CALL) && source.includes(REFRESH_INTERVAL),
      `This process outlives any single flag value, so it must call ` +
        `${REFRESH_CALL}) on the ${REFRESH_INTERVAL} timer rather than ` +
        "holding whatever was cached at startup.",
    ).toBe(true);
  });
});
