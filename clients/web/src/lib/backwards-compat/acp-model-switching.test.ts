import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import {
  MIN_VERSION,
  useAssistantScopedSupportsAcpModelSwitching,
} from "@/lib/backwards-compat/acp-model-switching";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER_ASSISTANT_ID = "asst-owner";

function setVersion(
  version: string | null,
  identityAssistantId: string | null = OWNER_ASSISTANT_ID,
) {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
}

function scopedSupports(assistantId: string | null | undefined): boolean {
  return renderHook(() =>
    useAssistantScopedSupportsAcpModelSwitching(assistantId),
  ).result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// The semver truth table lives in `utils.test.ts`, and the owner-scoping one
// too. What is pinned here is each side of this gate's dev floor, the policy on
// unknown, and that both gated surfaces follow the assistant they act on: the
// settings card writes `acp.defaultModel` to it, and the run panel posts
// `set-model` to it. During an assistant switch the active id moves first, and
// an unscoped answer off the outgoing version would light a card on a daemon
// that strips the key and leave a stale run's menu posting a missing route.
// `false` leaves the session on whatever model the adapter picks, which every
// assistant does.
describe("useAssistantScopedSupportsAcpModelSwitching", () => {
  test("false when the version is unknown", () => {
    setVersion(null);
    expect(scopedSupports(OWNER_ASSISTANT_ID)).toBe(false);
  });

  test("false for releases that predate the routes", () => {
    setVersion("0.11.9");
    expect(scopedSupports(OWNER_ASSISTANT_ID)).toBe(false);
  });

  test("false for the release the floor is based on", () => {
    // A dev floor is AHEAD of the stable release with the same base, so the
    // 0.11.10 cut does not carry commits stamped after it.
    setVersion("0.11.10");
    expect(scopedSupports(OWNER_ASSISTANT_ID)).toBe(false);
  });

  test("false for dev builds cut before the routes landed", () => {
    setVersion("0.11.10-dev.202609080000.0000000");
    expect(scopedSupports(OWNER_ASSISTANT_ID)).toBe(false);
  });

  test("true for the dev build the floor names", () => {
    setVersion(MIN_VERSION);
    expect(scopedSupports(OWNER_ASSISTANT_ID)).toBe(true);
  });

  test("true for later dev builds and later releases", () => {
    setVersion("0.11.10-dev.202609101200.1111111");
    expect(scopedSupports(OWNER_ASSISTANT_ID)).toBe(true);
    setVersion("0.11.11");
    expect(scopedSupports(OWNER_ASSISTANT_ID)).toBe(true);
  });

  // A `vel up` image stamps `local.YYYYMMDDHHMMSS`, which `versionSupports`
  // reads to the minute, the precision it shares with a CI `dev` stamp. So a
  // local build carries the floor's commits only if it was cut in that minute
  // or later, whatever its longer stamp says after it.
  test("compares a local build against the dev floor by its stamp", () => {
    setVersion("0.11.10-local.20260909053400.abcdef1");
    expect(scopedSupports(OWNER_ASSISTANT_ID)).toBe(true);
    setVersion("0.11.10-local.20260908235959.abcdef1");
    expect(scopedSupports(OWNER_ASSISTANT_ID)).toBe(false);
  });

  test("false when the supported version belongs to another assistant", () => {
    setVersion(MIN_VERSION, "asst-other");
    expect(scopedSupports(OWNER_ASSISTANT_ID)).toBe(false);
  });

  test("false without an assistant id", () => {
    setVersion(MIN_VERSION);
    expect(scopedSupports(null)).toBe(false);
    expect(scopedSupports(undefined)).toBe(false);
  });
});
