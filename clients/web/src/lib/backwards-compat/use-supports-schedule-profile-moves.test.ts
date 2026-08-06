import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  resolveSupportsScheduleProfileMoves,
  useSupportsScheduleProfileMoves,
} from "@/lib/backwards-compat/use-supports-schedule-profile-moves";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER = "asst-owner";
const OTHER = "asst-other";

/** Record an identity fetched for `assistantId` (defaults to the owner). */
function setIdentity(version: string | null, assistantId: string = OWNER) {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, assistantId);
}

/** Read the gate synchronously through the exported hook. */
function readGate(version: string | null): boolean {
  setIdentity(version);
  return renderHook(() => useSupportsScheduleProfileMoves(OWNER)).result
    .current;
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

  // A new-enough version belonging to a different assistant must not light up
  // this assistant's surface: mid-switch the store still holds the outgoing
  // assistant's identity.
  test("reads false when the hydrated version belongs to another assistant", () => {
    setIdentity("0.12.0", OTHER);
    expect(
      renderHook(() => useSupportsScheduleProfileMoves(OWNER)).result.current,
    ).toBe(false);
  });

  test("reads false without an owner to scope to", () => {
    setIdentity("0.12.0");
    expect(
      renderHook(() => useSupportsScheduleProfileMoves(null)).result.current,
    ).toBe(false);
  });
});

// The write-path variant waits for the owning assistant's version to hydrate
// rather than reading the conservative `false` a still-null version would
// give, so a delete confirmed right after load still moves the schedules.
describe("resolveSupportsScheduleProfileMoves", () => {
  test("waits for a late-arriving version instead of answering false", async () => {
    const pending = resolveSupportsScheduleProfileMoves(OWNER);
    setIdentity("0.12.0");
    expect(await pending).toBe(true);
  });

  test("reads false once a below-minimum version resolves", async () => {
    setIdentity("0.11.2");
    expect(await resolveSupportsScheduleProfileMoves(OWNER)).toBe(false);
  });

  // The switch case the scoping exists for: the settings page is already
  // showing the newly selected assistant while the identity store still holds
  // the one it switched away from. Answering from that stale pair would call
  // the reassign route against an assistant that may not have it.
  test("keeps waiting while the store holds another assistant's version", async () => {
    setIdentity("0.12.0", OTHER);
    let settled = false;
    const pending = resolveSupportsScheduleProfileMoves(OWNER).then((v) => {
      settled = true;
      return v;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    setIdentity("0.11.2", OWNER);
    expect(await pending).toBe(false);
  });
});
