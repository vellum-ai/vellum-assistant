import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  MIN_VERSION,
  resolveSupportsWatchSessions,
  supportsWatchSessions,
} from "@/lib/backwards-compat/watch-sessions";
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

// The exhaustive semver and owner-scoping truth table lives in `utils.test.ts`.
// What is checked here is each side of the boundary this gate names, the
// conservative-on-unknown policy, and that a version fetched for a DIFFERENT
// assistant cannot authorize this one. `false` means Watch is inert, which is
// a state every assistant understands.
describe("supportsWatchSessions", () => {
  test("false when the version is unknown", () => {
    seed(null);
    expect(supportsWatchSessions(OWNER_ASSISTANT_ID)).toBe(false);
  });

  test("false for assistants that predate the route", () => {
    seed("0.11.4");
    expect(supportsWatchSessions(OWNER_ASSISTANT_ID)).toBe(false);
    seed("0.11.3");
    expect(supportsWatchSessions(OWNER_ASSISTANT_ID)).toBe(false);
    seed("0.10.0");
    expect(supportsWatchSessions(OWNER_ASSISTANT_ID)).toBe(false);
  });

  /**
   * A dev build cut from the same base before the route landed reads as older,
   * which is what makes a dev floor safer than naming `dev.0`.
   */
  test("false for dev builds cut before the route landed", () => {
    seed("0.11.4-dev.202608190000.0000000");
    expect(supportsWatchSessions(OWNER_ASSISTANT_ID)).toBe(false);
  });

  test("true for the dev build the floor names and later ones", () => {
    seed(MIN_VERSION);
    expect(supportsWatchSessions(OWNER_ASSISTANT_ID)).toBe(true);
    seed("0.11.4-dev.202608220100.abcdef0");
    expect(supportsWatchSessions(OWNER_ASSISTANT_ID)).toBe(true);
  });

  test("true for every release after the base the floor sits on", () => {
    seed("0.11.5");
    expect(supportsWatchSessions(OWNER_ASSISTANT_ID)).toBe(true);
    seed("0.12.0");
    expect(supportsWatchSessions(OWNER_ASSISTANT_ID)).toBe(true);
  });

  /**
   * The session is bound to one assistant, so its gate is too. A version held
   * for the outgoing assistant must never authorize a capture against the
   * incoming one.
   */
  test("false when the version belongs to a different assistant", () => {
    seed("0.12.0", "asst-other");
    expect(supportsWatchSessions(OWNER_ASSISTANT_ID)).toBe(false);
  });

  test("false with no assistant to own the session", () => {
    seed("0.12.0");
    expect(supportsWatchSessions(null)).toBe(false);
  });
});

describe("resolveSupportsWatchSessions", () => {
  test("answers the snapshot once the version is in hand", async () => {
    seed("0.12.0");
    expect(await resolveSupportsWatchSessions(OWNER_ASSISTANT_ID)).toBe(true);
    seed("0.11.3");
    expect(await resolveSupportsWatchSessions(OWNER_ASSISTANT_ID)).toBe(false);
  });

  /**
   * The case the wait exists for: a press that lands while the identity fetch
   * is still in flight must not read the conservative `false` and refuse an
   * assistant that does support watching.
   */
  test("waits for a version still in flight rather than refusing", async () => {
    const pending = resolveSupportsWatchSessions(OWNER_ASSISTANT_ID);
    seed("0.12.0");
    expect(await pending).toBe(true);
  });

  test("resolves immediately with no assistant to wait for", async () => {
    expect(await resolveSupportsWatchSessions(null)).toBe(false);
  });
});
