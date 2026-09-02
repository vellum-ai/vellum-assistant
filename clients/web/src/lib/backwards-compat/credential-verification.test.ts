import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  MIN_VERSION,
  resolveSupportsCredentialVerification,
  supportsCredentialVerification,
} from "@/lib/backwards-compat/credential-verification";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null): void {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

// The semver truth table lives in `utils.test.ts`. Here we pin the floor
// itself: the dev build of the commit that landed the route, every build after
// it, and the plain release it was cut from, which does NOT carry the route
// (a same-source self-hosted daemon reports that plain number and correctly
// reads as unsupported).
describe("supportsCredentialVerification", () => {
  test("false when version is unknown", () => {
    setVersion(null);
    expect(supportsCredentialVerification()).toBe(false);
  });

  test("false for the plain release the floor was cut from", () => {
    setVersion("0.11.8");
    expect(supportsCredentialVerification()).toBe(false);
  });

  test("false for a dev build stamped before the route landed", () => {
    setVersion("0.11.8-dev.202609011800.0000000");
    expect(supportsCredentialVerification()).toBe(false);
  });

  test("true for the exact floor", () => {
    setVersion(MIN_VERSION);
    expect(supportsCredentialVerification()).toBe(true);
  });

  test("true for a later dev build and for later releases", () => {
    setVersion("0.11.8-dev.202609020000.abc1234");
    expect(supportsCredentialVerification()).toBe(true);
    setVersion("0.11.9");
    expect(supportsCredentialVerification()).toBe(true);
    setVersion("0.12.0");
    expect(supportsCredentialVerification()).toBe(true);
  });

  test("false for unparseable versions", () => {
    setVersion("not-a-version");
    expect(supportsCredentialVerification()).toBe(false);
  });
});

describe("resolveSupportsCredentialVerification", () => {
  test("reads the gate against the hydrated version", async () => {
    setVersion(MIN_VERSION);
    expect(await resolveSupportsCredentialVerification()).toBe(true);
    setVersion("0.11.8");
    expect(await resolveSupportsCredentialVerification()).toBe(false);
  });
});
