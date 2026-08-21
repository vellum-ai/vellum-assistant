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
   * The band this gate exists for. An assistant that serves `/v1/watch/stream`
   * but predates the announcement runs sessions and never settles the wait, so
   * without a floor of its own every stop would leave the surface expanded on
   * "Summarizing" until the three-minute give-up timer.
   */
  test("false for a build that serves watch sessions but not the announcement", () => {
    seed(WATCH_SESSIONS_MIN_VERSION);
    expect(supportsWatchRetroCompletion(OWNER_ASSISTANT_ID)).toBe(false);
  });

  /** Which is only a band at all because this floor is the later of the two. */
  test("the floor sits above the watch-sessions floor", () => {
    expect(versionSupports(MIN_VERSION, WATCH_SESSIONS_MIN_VERSION)).toBe(true);
    expect(versionSupports(WATCH_SESSIONS_MIN_VERSION, MIN_VERSION)).toBe(false);
  });

  test("true for the dev build the floor names and later ones", () => {
    seed(MIN_VERSION);
    expect(supportsWatchRetroCompletion(OWNER_ASSISTANT_ID)).toBe(true);
    seed("0.11.4-dev.202608210100.abcdef0");
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
