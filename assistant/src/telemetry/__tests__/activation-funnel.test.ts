import { describe, expect, test } from "bun:test";

import {
  ACTIVATION_STEP_NAMES,
  ACTIVATION_STEPS,
  activationStepIndex,
  buildActivationDaemonEventId,
  isActivationStepName,
} from "../activation-funnel.js";

describe("activation funnel vocabulary", () => {
  test("step indices are 1-6 and unique", () => {
    const indices = Object.values(ACTIVATION_STEPS).map((s) => s.stepIndex);
    expect([...indices].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(indices).size).toBe(indices.length);
  });

  test("activationStepIndex resolves index from name", () => {
    for (const { stepName, stepIndex } of Object.values(ACTIVATION_STEPS)) {
      expect(activationStepIndex(stepName)).toBe(stepIndex);
    }
  });

  test("isActivationStepName accepts all six step names", () => {
    expect(ACTIVATION_STEP_NAMES).toHaveLength(6);
    for (const stepName of ACTIVATION_STEP_NAMES) {
      expect(isActivationStepName(stepName)).toBe(true);
    }
  });

  test("isActivationStepName rejects unknown names", () => {
    expect(isActivationStepName("bogus")).toBe(false);
  });

  test("buildActivationDaemonEventId is deterministic", () => {
    expect(
      buildActivationDaemonEventId("conv-abc", "activation_msg_5_sent"),
    ).toBe("activation_v1_2026_06:conv-abc:activation_msg_5_sent");
  });
});
