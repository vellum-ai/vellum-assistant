import { afterEach, describe, expect, mock, test } from "bun:test";

import * as localModeHost from "@/runtime/local-mode-host";

const replacePlatformAssistantsHost = mock(
  async (
    _entries: Array<Record<string, unknown>>,
    _organizationId?: string,
  ) => ({
    ok: true as const,
    lockfile: { assistants: [], activeAssistant: null },
  }),
);

const loadLockfileHost = mock(async () => {
  throw new Error("host down");
});

mock.module("@/runtime/local-mode-host", () => ({
  ...localModeHost,
  replacePlatformAssistantsHost,
  loadLockfileHost,
}));

import {
  getActiveAssistant,
  getLocalAssistants,
  getLockfile,
  getPlatformAssistants,
  getSelectedAssistant,
  isLocalAssistant,
  isPlatformAssistant,
  loadLockfile,
  reconcileSelectedAssistant,
  syncPlatformAssistantsToLockfile,
} from "@/lib/local-mode";
import { SELECTED_ASSISTANT_STORAGE_KEY } from "@/assistant/selected-assistant-storage";
import type { Lockfile, LockfileAssistant } from "@/runtime/local-mode-host";
import { useLockfileStore } from "@/stores/lockfile-store";

const LOCKFILE_STORAGE_KEY = "vellum:local:lockfile";

function setSelected(id: string): void {
  localStorage.setItem(SELECTED_ASSISTANT_STORAGE_KEY, id);
}

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
  useLockfileStore.setState({ lockfile: null, committed: false });
  localStorage.removeItem(LOCKFILE_STORAGE_KEY);
  localStorage.removeItem(SELECTED_ASSISTANT_STORAGE_KEY);
  replacePlatformAssistantsHost.mockClear();
});

describe("syncPlatformAssistantsToLockfile", () => {
  const remote = {
    id: "platform-a",
    name: "A",
    is_local: false,
    created: "2026-01-01",
  };

  test("skips the host replace when the org is unresolved (no wipe)", async () => {
    await syncPlatformAssistantsToLockfile([remote], undefined);
    await syncPlatformAssistantsToLockfile([remote]);

    expect(replacePlatformAssistantsHost).not.toHaveBeenCalled();
  });

  test("runs the host replace when an org is provided", async () => {
    await syncPlatformAssistantsToLockfile([remote], "org-1");

    expect(replacePlatformAssistantsHost).toHaveBeenCalledTimes(1);
    const [entries, org] = replacePlatformAssistantsHost.mock.calls[0]!;
    expect(org).toBe("org-1");
    expect(entries).toEqual([
      expect.objectContaining({ assistantId: "platform-a", organizationId: "org-1" }),
    ]);
  });

  test("backs out before the host replace when shouldApply is false", async () => {
    await syncPlatformAssistantsToLockfile([remote], "org-1", () => false);

    expect(replacePlatformAssistantsHost).not.toHaveBeenCalled();
  });

  test("skips the commit when shouldApply flips false during the replace", async () => {
    let fresh = true;
    replacePlatformAssistantsHost.mockImplementationOnce(async () => {
      fresh = false;
      return {
        ok: true as const,
        lockfile: { assistants: [], activeAssistant: null },
      };
    });

    await syncPlatformAssistantsToLockfile([remote], "org-1", () => fresh);

    expect(replacePlatformAssistantsHost).toHaveBeenCalledTimes(1);
    expect(useLockfileStore.getState().lockfile).toBeNull();
    expect(localStorage.getItem(LOCKFILE_STORAGE_KEY)).toBeNull();
  });
});

describe("loadLockfile host-failure fallback", () => {
  test("keeps the cached lockfile instead of clobbering it with empty", async () => {
    useLockfileStore
      .getState()
      .setLockfile({ assistants: [localA], activeAssistant: "local-a" });

    const result = await loadLockfile();

    expect(result.assistants).toEqual([localA]);
    expect(useLockfileStore.getState().lockfile?.assistants).toEqual([localA]);
    expect(useLockfileStore.getState().committed).toBe(true);
  });

  test("falls back to the persisted mirror when nothing is cached", async () => {
    localStorage.setItem(
      LOCKFILE_STORAGE_KEY,
      JSON.stringify({ assistants: [localA], activeAssistant: null }),
    );

    const result = await loadLockfile();

    expect(result.assistants.map((a) => a.assistantId)).toEqual(["local-a"]);
    expect(useLockfileStore.getState().committed).toBe(true);
  });

  test("records the empty fallback as not committed", async () => {
    const result = await loadLockfile();

    expect(result.assistants).toEqual([]);
    expect(useLockfileStore.getState().committed).toBe(false);
  });
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

describe("reconcileSelectedAssistant", () => {
  test("clears a stale selection whose id is absent from the lockfile", () => {
    setLockfile({ assistants: [localA], activeAssistant: "local-a" });
    setSelected("local-b");

    reconcileSelectedAssistant();

    expect(
      localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY),
    ).toBeNull();
    expect(getSelectedAssistant()).toBe(localA);
  });

  test("preserves a selection that is still present in the lockfile", () => {
    setLockfile({ assistants: [localA, localB], activeAssistant: "local-a" });
    setSelected("local-b");

    reconcileSelectedAssistant();

    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBe("local-b");
    expect(getSelectedAssistant()).toBe(localB);
  });

  test("is a no-op when there is no tab-local selection", () => {
    setLockfile({ assistants: [localA], activeAssistant: "local-a" });

    reconcileSelectedAssistant();

    expect(
      localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY),
    ).toBeNull();
  });

  test("a transient empty-lockfile read does not clear the selection", () => {
    // No cached lockfile and nothing persisted → getLockfile() hits its empty
    // fallback (setCachedLockfile), which must NOT reconcile. Otherwise a boot/
    // read failure would wrongly drop a still-valid selection.
    setSelected("local-a");

    getLockfile();

    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBe("local-a");
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
