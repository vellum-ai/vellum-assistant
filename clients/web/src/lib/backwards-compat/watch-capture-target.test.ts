import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  MIN_VERSION,
  supportsWatchCaptureTarget,
} from "@/lib/backwards-compat/watch-capture-target";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER_ASSISTANT_ID = "asst-owner";

const seed = (
  version: string | null,
  identityAssistantId: string | null = OWNER_ASSISTANT_ID,
) => {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
};

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

// The semver and owner-scoping truth table lives in `utils.test.ts`. What is
// pinned here is each side of this gate's boundary and the policy on unknown:
// `false` leaves a session reading the whole screen, which every assistant
// understands and which the frame then draws honestly.
describe("supportsWatchCaptureTarget", () => {
  test("false when the version is unknown", () => {
    seed(null);
    expect(supportsWatchCaptureTarget(OWNER_ASSISTANT_ID)).toBe(false);
  });

  test("false for assistants that ignore the parameters", () => {
    seed("0.11.8");
    expect(supportsWatchCaptureTarget(OWNER_ASSISTANT_ID)).toBe(false);
    seed("0.11.7");
    expect(supportsWatchCaptureTarget(OWNER_ASSISTANT_ID)).toBe(false);
  });

  test("false for dev builds cut before the parameters landed", () => {
    seed("0.11.8-dev.202609020000.0000000");
    expect(supportsWatchCaptureTarget(OWNER_ASSISTANT_ID)).toBe(false);
  });

  test("true for the dev build the floor names and later ones", () => {
    seed(MIN_VERSION);
    expect(supportsWatchCaptureTarget(OWNER_ASSISTANT_ID)).toBe(true);
    seed("0.11.8-dev.202609041200.1111111");
    expect(supportsWatchCaptureTarget(OWNER_ASSISTANT_ID)).toBe(true);
    seed("0.11.9");
    expect(supportsWatchCaptureTarget(OWNER_ASSISTANT_ID)).toBe(true);
  });

  test("false when the version belongs to a different assistant", () => {
    seed(MIN_VERSION, "asst-other");
    expect(supportsWatchCaptureTarget(OWNER_ASSISTANT_ID)).toBe(false);
  });

  test("false for no assistant at all", () => {
    seed(MIN_VERSION);
    expect(supportsWatchCaptureTarget(null)).toBe(false);
    expect(supportsWatchCaptureTarget(undefined)).toBe(false);
  });
});
