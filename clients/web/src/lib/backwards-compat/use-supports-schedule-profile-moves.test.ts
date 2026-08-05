import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  resolveSupportsScheduleProfileMoves,
  useSupportsScheduleProfileMoves,
} from "@/lib/backwards-compat/use-supports-schedule-profile-moves";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

/** Read the gate synchronously through the exported hook. */
function readGate(version: string | null): boolean {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
  return renderHook(() => useSupportsScheduleProfileMoves()).result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// The exhaustive semver truth-table lives in `utils.test.ts`. Here we verify
// each side of the 0.12.0 boundary (the first release carrying
// `POST /schedules/reassign-profile` and the `inference_profile` list filter)
// plus the conservative-on-unknown policy. `false` means the profile-delete
// flow skips the schedule scan and the reassign call entirely.
describe("useSupportsScheduleProfileMoves", () => {
  test("reads false when the version is unknown", () => {
    expect(readGate(null)).toBe(false);
  });

  test("reads false below 0.12.0", () => {
    expect(readGate("0.11.2")).toBe(false);
    expect(readGate("0.11.0")).toBe(false);
    expect(readGate("0.10.8")).toBe(false);
  });

  test("reads true for assistants on 0.12.0+", () => {
    expect(readGate("0.12.0")).toBe(true);
    expect(readGate("0.12.1")).toBe(true);
    expect(readGate("1.0.0")).toBe(true);
  });

  test("reads true for RC builds of the cutover release", () => {
    expect(readGate("0.12.0-rc.1")).toBe(true);
  });

  test("reads false for unparseable versions", () => {
    expect(readGate("garbage")).toBe(false);
    expect(readGate("0.12")).toBe(false);
  });
});

// The write-path variant waits for the version to hydrate rather than reading
// the conservative `false` a still-null version would give, so a delete
// confirmed right after load still moves the schedules.
describe("resolveSupportsScheduleProfileMoves", () => {
  test("waits for a late-arriving version instead of answering false", async () => {
    const pending = resolveSupportsScheduleProfileMoves();
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.12.0");
    expect(await pending).toBe(true);
  });

  test("reads false once a below-minimum version resolves", async () => {
    useAssistantIdentityStore.getState().setIdentity("test-asst", "0.11.2");
    expect(await resolveSupportsScheduleProfileMoves()).toBe(false);
  });
});
