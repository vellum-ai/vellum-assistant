import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
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
