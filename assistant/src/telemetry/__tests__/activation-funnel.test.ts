import { describe, expect, test } from "bun:test";

import {
  ACTIVATION_MOMENT_PARAMS,
  ACTIVATION_STEPS,
  activationStepIndex,
  activationStepNameForMomentParam,
  buildActivationDaemonEventId,
  isActivationMomentParam,
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

describe("activation moment param (model-facing tag)", () => {
  test("ACTIVATION_MOMENT_PARAMS lists the five tokens in step order", () => {
    expect(ACTIVATION_MOMENT_PARAMS).toEqual([
      "moment_1",
      "moment_2",
      "moment_3",
      "first_wow_executed",
      "first_wow_interacted",
    ]);
  });

  test("isActivationMomentParam accepts all five tokens", () => {
    for (const param of ACTIVATION_MOMENT_PARAMS) {
      expect(isActivationMomentParam(param)).toBe(true);
    }
  });

  test("isActivationMomentParam rejects unknown tokens (incl. wire step names)", () => {
    expect(isActivationMomentParam("bogus")).toBe(false);
    // The wire step name is NOT a valid model-facing token.
    expect(isActivationMomentParam("activation_moment_1_complete")).toBe(false);
    expect(isActivationMomentParam("moment_4")).toBe(false);
  });

  test("activationStepNameForMomentParam maps each token to its step name", () => {
    expect(activationStepNameForMomentParam("moment_1")).toBe(
      ACTIVATION_STEPS.moment1.stepName,
    );
    expect(activationStepNameForMomentParam("moment_2")).toBe(
      ACTIVATION_STEPS.moment2.stepName,
    );
    expect(activationStepNameForMomentParam("moment_3")).toBe(
      ACTIVATION_STEPS.moment3.stepName,
    );
    expect(activationStepNameForMomentParam("first_wow_executed")).toBe(
      ACTIVATION_STEPS.firstWowExecuted.stepName,
    );
    expect(activationStepNameForMomentParam("first_wow_interacted")).toBe(
      ACTIVATION_STEPS.firstWowInteracted.stepName,
    );
  });

  test("every moment param maps to a valid wire step name", () => {
    for (const param of ACTIVATION_MOMENT_PARAMS) {
      expect(
        isActivationStepName(activationStepNameForMomentParam(param)),
      ).toBe(true);
    }
  });
});
