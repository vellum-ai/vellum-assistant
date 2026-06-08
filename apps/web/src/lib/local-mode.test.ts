import { afterEach, describe, expect, test } from "bun:test";

import {
  getActiveAssistant,
  getLocalAssistants,
  getLockfile,
  getPlatformAssistants,
  isLocalAssistant,
  isPlatformAssistant,
} from "@/lib/local-mode";
import type { Lockfile, LockfileAssistant } from "@/runtime/local-mode-host";
import { useLockfileStore } from "@/stores/lockfile-store";

const LOCKFILE_STORAGE_KEY = "vellum:local:lockfile";

const localA: LockfileAssistant = {
  assistantId: "local-a",
  cloud: "local",
  resources: { gatewayPort: 7830 },
} as LockfileAssistant;

const localB: LockfileAssistant = {
  assistantId: "local-b",
  cloud: "local",
  resources: { gatewayPort: 7831 },
} as LockfileAssistant;

const platform: LockfileAssistant = {
  assistantId: "platform-a",
  cloud: "vellum",
} as LockfileAssistant;

function setLockfile(lockfile: Lockfile): void {
  useLockfileStore.setState({ lockfile });
}

afterEach(() => {
  useLockfileStore.setState({ lockfile: null });
  localStorage.removeItem(LOCKFILE_STORAGE_KEY);
});

describe("assistant classification", () => {
  test("a vellum-cloud entry is a platform assistant, not local", () => {
    expect(isPlatformAssistant(platform)).toBe(true);
    expect(isLocalAssistant(platform)).toBe(false);
  });

  test("a non-vellum entry with a gateway port is local, not platform", () => {
    expect(isLocalAssistant(localA)).toBe(true);
    expect(isPlatformAssistant(localA)).toBe(false);
  });

  test("a non-vellum entry without resources is not treated as local", () => {
    const partial = { assistantId: "x", cloud: "local" } as LockfileAssistant;
    expect(isLocalAssistant(partial)).toBe(false);
  });

  test("getLocalAssistants / getPlatformAssistants partition by cloud", () => {
    setLockfile({ assistants: [localA, platform], activeAssistant: null });
    expect(getLocalAssistants()).toEqual([localA]);
    expect(getPlatformAssistants()).toEqual([platform]);
  });
});

describe("getActiveAssistant", () => {
  test("returns the entry matching the recorded active id", () => {
    setLockfile({ assistants: [localA, localB], activeAssistant: "local-b" });
    expect(getActiveAssistant()).toBe(localB);
  });

  test("returns the sole assistant when the active id is stale", () => {
    setLockfile({ assistants: [localA], activeAssistant: "gone" });
    expect(getActiveAssistant()).toBe(localA);
  });

  test("returns undefined when the active id is stale and the choice is ambiguous", () => {
    setLockfile({ assistants: [localA, localB], activeAssistant: "gone" });
    expect(getActiveAssistant()).toBeUndefined();
  });

  test("does not bind to the first entry when a later one is active", () => {
    setLockfile({ assistants: [localA, localB], activeAssistant: "local-b" });
    expect(getActiveAssistant()).not.toBe(localA);
  });
});

describe("getLockfile persisted-storage read", () => {
  test("validates the persisted lockfile, salvaging usable entries", () => {
    localStorage.setItem(
      LOCKFILE_STORAGE_KEY,
      JSON.stringify({
        activeAssistant: "local-a",
        assistants: [
          { assistantId: "local-a", cloud: "local" },
          { cloud: "local" },
        ],
      }),
    );
    const lockfile = getLockfile();
    expect(lockfile.activeAssistant).toBe("local-a");
    expect(lockfile.assistants).toEqual([
      { assistantId: "local-a", cloud: "local" },
    ]);
  });

  test("falls back to an empty lockfile when the stored value is not JSON", () => {
    localStorage.setItem(LOCKFILE_STORAGE_KEY, "{not json");
    expect(getLockfile()).toEqual({ assistants: [], activeAssistant: null });
  });
});
