import { describe, expect, test } from "bun:test";

import {
  ACTIVATION_STEPS,
  activationStepIndex,
  buildActivationDaemonEventId,
  isActivationStepName,
} from "../activation-funnel.js";

const ALL_STEP_NAMES = Object.values(ACTIVATION_STEPS).map((s) => s.stepName);

describe("activation funnel vocabulary", () => {
  test("step indices are 1-5 and unique", () => {
    const indices = Object.values(ACTIVATION_STEPS).map((s) => s.stepIndex);
    expect([...indices].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(indices).size).toBe(indices.length);
  });

  test("activationStepIndex resolves index from name", () => {
    for (const { stepName, stepIndex } of Object.values(ACTIVATION_STEPS)) {
      expect(activationStepIndex(stepName)).toBe(stepIndex);
    }
  });

  test("isActivationStepName accepts all five step names", () => {
    expect(ALL_STEP_NAMES).toHaveLength(5);
    for (const stepName of ALL_STEP_NAMES) {
      expect(isActivationStepName(stepName)).toBe(true);
    }
  });

  test("isActivationStepName rejects unknown names", () => {
    expect(isActivationStepName("bogus")).toBe(false);
  });

  test("buildActivationDaemonEventId is deterministic", () => {
    expect(
      buildActivationDaemonEventId("conv-abc", "activation_moment_1_complete"),
    ).toBe("activation_v1_2026_06:conv-abc:activation_moment_1_complete");
  });
});
