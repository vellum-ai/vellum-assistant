import { afterEach, describe, expect, test } from "bun:test";

import {
  __resetDoctorHandoffForTesting,
  useDoctorHandoffStore,
} from "@/stores/doctor-handoff-store";

afterEach(() => {
  __resetDoctorHandoffForTesting();
});

describe("doctor-handoff-store", () => {
  test("starts empty", () => {
    // GIVEN a fresh store
    // THEN there is no pending prompt
    expect(useDoctorHandoffStore.getState().pendingPrompt).toBeNull();
  });

  test("consume returns and clears the parked prompt", () => {
    // GIVEN a parked prompt
    useDoctorHandoffStore.getState().setPendingPrompt("fix my profiles");

    // WHEN consumed
    const first = useDoctorHandoffStore.getState().consumePendingPrompt();

    // THEN it is returned once and cleared for subsequent reads
    expect(first).toBe("fix my profiles");
    expect(useDoctorHandoffStore.getState().pendingPrompt).toBeNull();
    expect(useDoctorHandoffStore.getState().consumePendingPrompt()).toBeNull();
  });

  test("latest prompt wins when set twice before consumption", () => {
    // GIVEN two prompts parked before either is consumed
    useDoctorHandoffStore.getState().setPendingPrompt("first");
    useDoctorHandoffStore.getState().setPendingPrompt("second");

    // WHEN consumed
    // THEN the most recent one is returned
    expect(useDoctorHandoffStore.getState().consumePendingPrompt()).toBe(
      "second",
    );
  });
});
