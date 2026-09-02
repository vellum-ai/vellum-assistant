import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  MIN_VERSION,
  resolveSupportsCredentialVerification,
  supportsCredentialVerification,
} from "@/lib/backwards-compat/credential-verification";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const OWNER = "asst-owner";

function setVersion(
  version: string | null,
  identityAssistantId: string | null = OWNER,
): void {
  useAssistantIdentityStore
    .getState()
    .setIdentity("test-asst", version, identityAssistantId);
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

// The semver truth table and the owner-scoping rule live in `utils.test.ts`.
// Here we pin the floor itself (the dev build of the commit that landed the
// route, every build after it, and the plain release it was cut from, which
// does NOT carry the route) and that a version held for a different assistant
// cannot vouch for the one being repaired.

/**
 * A dev version `minutes` away from the floor's stamped minute, same base and
 * a different sha, so the cases stay tied to `MIN_VERSION` rather than to a
 * literal that silently crosses it when the floor moves.
 */
function devVersionFromFloor(minutes: number): string {
  const match = /^(.+)-dev\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\./.exec(
    MIN_VERSION,
  );
  if (!match) {
    throw new Error(`MIN_VERSION is not a dev floor: ${MIN_VERSION}`);
  }
  const [, base, y, mo, d, h, mi] = match;
  const at = new Date(
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi) + minutes,
    ),
  );
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`;
  return `${base}-dev.${stamp}.abc1234`;
}

describe("supportsCredentialVerification", () => {
  test("false when version is unknown", () => {
    setVersion(null);
    expect(supportsCredentialVerification(OWNER)).toBe(false);
  });

  test("false for the plain release the floor was cut from", () => {
    setVersion("0.11.8");
    expect(supportsCredentialVerification(OWNER)).toBe(false);
  });

  test("false for a dev build stamped before the route landed", () => {
    setVersion(devVersionFromFloor(-1));
    expect(supportsCredentialVerification(OWNER)).toBe(false);
  });

  test("true for the exact floor", () => {
    setVersion(MIN_VERSION);
    expect(supportsCredentialVerification(OWNER)).toBe(true);
  });

  test("true for a later dev build and for later releases", () => {
    setVersion(devVersionFromFloor(1));
    expect(supportsCredentialVerification(OWNER)).toBe(true);
    setVersion("0.11.9");
    expect(supportsCredentialVerification(OWNER)).toBe(true);
    setVersion("0.12.0");
    expect(supportsCredentialVerification(OWNER)).toBe(true);
  });

  test("false for unparseable versions", () => {
    setVersion("not-a-version");
    expect(supportsCredentialVerification(OWNER)).toBe(false);
  });

  // The switch window: the store still holds the outgoing assistant's
  // version while the repair targets the incoming one.
  test("false when the held version belongs to a different assistant", () => {
    setVersion(MIN_VERSION, "asst-other");
    expect(supportsCredentialVerification(OWNER)).toBe(false);
  });

  test("false with no owner even on a supported version", () => {
    setVersion(MIN_VERSION);
    expect(supportsCredentialVerification(null)).toBe(false);
  });
});

describe("resolveSupportsCredentialVerification", () => {
  test("reads the scoped gate against the hydrated version", async () => {
    setVersion(MIN_VERSION);
    expect(await resolveSupportsCredentialVerification(OWNER)).toBe(true);
    setVersion("0.11.8");
    expect(await resolveSupportsCredentialVerification(OWNER)).toBe(false);
  });
});
