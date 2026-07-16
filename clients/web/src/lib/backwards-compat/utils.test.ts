import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  useAssistantScopedSupports,
  useAssistantSupports,
  whenAssistantVersionKnown,
} from "@/lib/backwards-compat/utils";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

function setVersion(version: string | null) {
  useAssistantIdentityStore.getState().setIdentity("test-asst", version);
}

function check(version: string | null, minVersion: string): boolean {
  setVersion(version);
  const { result } = renderHook(() => useAssistantSupports(minVersion));
  return result.current;
}

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useAssistantSupports", () => {
  test("returns false when the version is unknown", () => {
    expect(check(null, "0.8.5")).toBe(false);
    expect(check("", "0.8.5")).toBe(false);
  });

  test("returns false for unparseable versions", () => {
    expect(check("not-a-version", "0.8.5")).toBe(false);
    expect(check("0.8", "0.8.5")).toBe(false);
  });

  test("returns false when the minVersion is unparseable", () => {
    expect(check("0.8.5", "garbage")).toBe(false);
  });

  test("returns true when version >= minVersion", () => {
    expect(check("0.8.5", "0.8.5")).toBe(true);
    expect(check("0.8.6", "0.8.5")).toBe(true);
    expect(check("0.9.0", "0.8.5")).toBe(true);
    expect(check("1.0.0", "0.8.5")).toBe(true);
  });

  test("returns false when version < minVersion", () => {
    expect(check("0.8.4", "0.8.5")).toBe(false);
    expect(check("0.7.99", "0.8.5")).toBe(false);
    expect(check("0.0.1", "0.8.5")).toBe(false);
  });

  test("treats pre-release suffixes as the full patch version", () => {
    // 0.8.5-rc.1 counts as >= 0.8.5, not the strict-semver "less than"
    // it would normally be. Testers on RCs get the new path.
    expect(check("0.8.5-rc.1", "0.8.5")).toBe(true);
    expect(check("0.8.5-alpha", "0.8.5")).toBe(true);
    expect(check("0.9.0-beta.3", "0.8.5")).toBe(true);
  });

  test("strips leading 'v' prefix on the version", () => {
    expect(check("v0.8.5", "0.8.5")).toBe(true);
    expect(check("v0.8.4", "0.8.5")).toBe(false);
  });

  test("treats dev pre-releases as ahead of stable with same base", () => {
    // Dev builds contain unreleased commits on top of the stable
    // release, so 0.10.0-dev.x is AHEAD of 0.10.0 stable.
    expect(check("0.10.0-dev.202606211252.5cf8576", "0.10.0")).toBe(true);
    expect(check("0.10.0-dev.1", "0.10.0")).toBe(true);
  });

  test("compares two dev versions by timestamp", () => {
    // Same base version, compare by pre-release string (timestamp).
    const min = "0.10.0-dev.202606211252.5cf8576";
    expect(check("0.10.0-dev.202606211252.5cf8576", min)).toBe(true);
    expect(check("0.10.0-dev.202606211300.abcdef", min)).toBe(true);
    expect(check("0.10.0-dev.202606211200.abcdef", min)).toBe(false);
    // Different base — higher base wins regardless of dev suffix.
    expect(check("0.10.0-dev.202606211252.5cf8576", "0.10.1")).toBe(false);
    expect(check("0.10.1-dev.1", "0.10.0-dev.202606211252.5cf8576")).toBe(true);
  });

  test("stable is behind dev with same base", () => {
    // 0.10.0 stable was released before the dev changes.
    expect(check("0.10.0", "0.10.0-dev.202606211252.5cf8576")).toBe(false);
    // But 0.10.1 stable (next release) is ahead.
    expect(check("0.10.1", "0.10.0-dev.202606211252.5cf8576")).toBe(true);
  });
});

describe("useAssistantScopedSupports", () => {
  const OWNER_ID = "asst-owner";
  const MIN = "0.11.0";

  function setIdentity(version: string | null, assistantId: string | null) {
    useAssistantIdentityStore
      .getState()
      .setIdentity("test-asst", version, assistantId);
  }

  function checkScoped(
    version: string | null,
    ownerAssistantId: string | null | undefined = OWNER_ID,
    identityAssistantId: string | null = OWNER_ID,
  ): boolean {
    setIdentity(version, identityAssistantId);
    const { result } = renderHook(() =>
      useAssistantScopedSupports(MIN, ownerAssistantId),
    );
    return result.current;
  }

  test("returns true when the version meets minVersion and the owner matches", () => {
    expect(checkScoped("0.11.0")).toBe(true);
    expect(checkScoped("1.0.0")).toBe(true);
  });

  test("returns false when the version is unknown or below minVersion", () => {
    expect(checkScoped(null)).toBe(false);
    expect(checkScoped("0.10.9")).toBe(false);
  });

  test("returns false when the identity version belongs to a different assistant", () => {
    // The assistant-switch race: the previous assistant's supported
    // version is still hydrated while the gated surface now belongs to a
    // different assistant whose identity hasn't loaded. The version must
    // not validate the new owner's surface.
    expect(checkScoped("0.11.0", "asst-new-owner", "asst-previous")).toBe(
      false,
    );
  });

  test("returns false when the owner is null or undefined", () => {
    expect(checkScoped("0.11.0", null)).toBe(false);
    // Passed explicitly (a default parameter would swallow `undefined`).
    setIdentity("0.11.0", OWNER_ID);
    const { result } = renderHook(() =>
      useAssistantScopedSupports(MIN, undefined),
    );
    expect(result.current).toBe(false);
  });

  test("returns false when the identity store has no owner recorded", () => {
    expect(checkScoped("0.11.0", OWNER_ID, null)).toBe(false);
  });

  test("flips off the moment the identity is cleared for an assistant switch", () => {
    setIdentity("0.11.0", OWNER_ID);
    const { result, rerender } = renderHook(() =>
      useAssistantScopedSupports(MIN, OWNER_ID),
    );
    expect(result.current).toBe(true);
    useAssistantIdentityStore.getState().clearIdentity();
    rerender();
    expect(result.current).toBe(false);
  });
});

describe("whenAssistantVersionKnown", () => {
  test("resolves immediately when the version is already known", async () => {
    setVersion("0.8.6");
    let resolved = false;
    const promise = whenAssistantVersionKnown(50).then(() => {
      resolved = true;
    });
    await promise;
    expect(resolved).toBe(true);
  });

  test("resolves once the version hydrates after the call", async () => {
    let resolved = false;
    const promise = whenAssistantVersionKnown(1_000).then(() => {
      resolved = true;
    });

    // Not resolved while the version is still null.
    await Promise.resolve();
    expect(resolved).toBe(false);

    setVersion("0.8.7");
    await promise;
    expect(resolved).toBe(true);
  });

  test("resolves on the timeout when the version never hydrates", async () => {
    const start = Date.now();
    await whenAssistantVersionKnown(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    expect(useAssistantIdentityStore.getState().version).toBeNull();
  });
});
