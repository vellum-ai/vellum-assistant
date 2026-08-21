import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { MIN_VERSION as WATCH_SESSIONS_MIN_VERSION } from "@/lib/backwards-compat/watch-sessions";
import {
  MIN_VERSION,
  supportsWatchRetroCompletion,
} from "@/lib/backwards-compat/watch-retro-completion";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { versionSupports } from "@/lib/backwards-compat/utils";

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

// The exhaustive semver and owner-scoping truth table lives in `utils.test.ts`.
// What is checked here is each side of the boundary this gate names, the
// conservative-on-unknown policy, and that a version fetched for a DIFFERENT
// assistant cannot authorize this one. `false` means a stop returns the surface
// straight to resting, which is what it did before the summary existed.
describe("supportsWatchRetroCompletion", () => {
  test("false when the version is unknown", () => {
    seed(null);
    expect(supportsWatchRetroCompletion(OWNER_ASSISTANT_ID)).toBe(false);
  });

  test("false for assistants that predate the event", () => {
    seed("0.11.4");
    expect(supportsWatchRetroCompletion(OWNER_ASSISTANT_ID)).toBe(false);
    seed("0.11.3");
    expect(supportsWatchRetroCompletion(OWNER_ASSISTANT_ID)).toBe(false);
    seed("0.10.0");
    expect(supportsWatchRetroCompletion(OWNER_ASSISTANT_ID)).toBe(false);
  });

  /**
   * A build that serves the stream announces too, because both arrived in one
   * merge. The gate still has to answer for the builds below that merge, which
   * is what the case below covers.
   */
  test("true for a build that serves watch sessions", () => {
    seed(WATCH_SESSIONS_MIN_VERSION);
    expect(supportsWatchRetroCompletion(OWNER_ASSISTANT_ID)).toBe(true);
  });

  /**
   * The stop edge's old behavior, which is what this gate protects: a build
   * from before the merge returns the surface straight to resting rather than
   * opening a wait nothing will settle.
   */
  test("false for a dev build cut before the merge", () => {
    seed("0.11.4-dev.202608201200.0000000");
    expect(supportsWatchRetroCompletion(OWNER_ASSISTANT_ID)).toBe(false);
  });

  /**
   * The route and the announcement landed on `main` in one merge, so the band
   * between them is empty and this floor is that floor. Pinned so a later
   * stamp on one of them is a deliberate parting rather than a silent one.
   */
  test("the floor is the watch stream's floor", () => {
    expect(MIN_VERSION).toBe(WATCH_SESSIONS_MIN_VERSION);
    expect(versionSupports(MIN_VERSION, WATCH_SESSIONS_MIN_VERSION)).toBe(true);
    expect(versionSupports(WATCH_SESSIONS_MIN_VERSION, MIN_VERSION)).toBe(true);
  });

  test("true for the dev build the floor names and later ones", () => {
    seed(MIN_VERSION);
    expect(supportsWatchRetroCompletion(OWNER_ASSISTANT_ID)).toBe(true);
    seed("0.11.4-dev.202608220100.abcdef0");
    expect(supportsWatchRetroCompletion(OWNER_ASSISTANT_ID)).toBe(true);
  });

  test("true for every release after the base the floor sits on", () => {
    seed("0.11.5");
    expect(supportsWatchRetroCompletion(OWNER_ASSISTANT_ID)).toBe(true);
    seed("0.12.0");
    expect(supportsWatchRetroCompletion(OWNER_ASSISTANT_ID)).toBe(true);
  });

  /**
   * The announcement arrives on the owning assistant's event stream, so a
   * version fetched for the outgoing assistant must not authorize a wait on the
   * incoming one's.
   */
  test("false when the version belongs to a different assistant", () => {
    seed("0.12.0", "asst-other");
    expect(supportsWatchRetroCompletion(OWNER_ASSISTANT_ID)).toBe(false);
  });

  test("false with no assistant to own the summary", () => {
    seed("0.12.0");
    expect(supportsWatchRetroCompletion(null)).toBe(false);
  });
});
