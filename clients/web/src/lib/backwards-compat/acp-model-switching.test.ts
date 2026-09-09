import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { cleanup, renderHook } from "@testing-library/react";

import {
  MIN_VERSION,
  useAssistantScopedSupportsAcpModelSwitching,
  useSupportsAcpModelSwitching,
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

function supports(): boolean {
  return renderHook(() => useSupportsAcpModelSwitching()).result.current;
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

// The semver truth table lives in `utils.test.ts`. What is pinned here is each
// side of this gate's dev floor and the policy on unknown: `false` leaves the
// session on whatever model the adapter picks, which every assistant does.
describe("useSupportsAcpModelSwitching", () => {
  test("false when the version is unknown", () => {
    setVersion(null);
    expect(supports()).toBe(false);
  });

  test("false for releases that predate the routes", () => {
    setVersion("0.11.9");
    expect(supports()).toBe(false);
  });

  test("false for the release the floor is based on", () => {
    // A dev floor is AHEAD of the stable release with the same base, so the
    // 0.11.10 cut does not carry commits stamped after it.
    setVersion("0.11.10");
    expect(supports()).toBe(false);
  });

  test("false for dev builds cut before the routes landed", () => {
    setVersion("0.11.10-dev.202609080000.0000000");
    expect(supports()).toBe(false);
  });

  test("true for the dev build the floor names", () => {
    setVersion(MIN_VERSION);
    expect(supports()).toBe(true);
  });

  test("true for later dev builds and later releases", () => {
    setVersion("0.11.10-dev.202609101200.1111111");
    expect(supports()).toBe(true);
    setVersion("0.11.11");
    expect(supports()).toBe(true);
  });
});

// The owner-scoping truth table lives in `utils.test.ts`. What is pinned here
// is that the settings card's gate follows the assistant it writes to: during
// an assistant switch the active id moves first, and an unscoped answer off
// the outgoing version would light the card on a daemon that strips the key.
describe("useAssistantScopedSupportsAcpModelSwitching", () => {
  test("true when the supported version was fetched for this assistant", () => {
    setVersion(MIN_VERSION);
    expect(scopedSupports(OWNER_ASSISTANT_ID)).toBe(true);
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

  test("false when the scoped version predates the floor", () => {
    setVersion("0.11.9");
    expect(scopedSupports(OWNER_ASSISTANT_ID)).toBe(false);
    setVersion(null);
    expect(scopedSupports(OWNER_ASSISTANT_ID)).toBe(false);
  });
});
