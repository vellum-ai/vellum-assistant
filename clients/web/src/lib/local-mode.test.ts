import { afterEach, describe, expect, mock, test } from "bun:test";

import { parseLockfile } from "@vellumai/local-mode/contract";

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

const saveLockfileAssistantHost = mock(
  async (
    _entry: Record<string, unknown>,
    _activeAssistant: string | undefined,
  ) => ({
    ok: true as const,
    lockfile: { assistants: [localA], activeAssistant: "local-a" },
  }),
);

mock.module("@/runtime/local-mode-host", () => ({
  ...localModeHost,
  replacePlatformAssistantsHost,
  saveLockfileAssistantHost,
  loadLockfileHost,
}));

import {
  getActiveAssistant,
  getLocalGatewayUrl,
  getLocalAssistants,
  getLockfile,
  getPlatformAssistants,
  getSelectedAssistant,
  isCliWakeableAssistant,
  isLocalAssistant,
  isPlatformAssistant,
  isRemoteGatewayMode,
  loadLockfile,
  primeLocalGatewayConnection,
  reconcileSelectedAssistant,
  syncPlatformAssistantsToLockfile,
  updateLockfileAssistant,
  UnresolvedLocalGatewayError,
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

// Tests default to platform mode (test-setup.ts pins VITE_PLATFORM_MODE).
// Local-mode behaviour is opt-in per test; the afterEach restores the default.
function enableLocalMode(): void {
  process.env.VITE_PLATFORM_MODE = "";
}

afterEach(() => {
  window.__VELLUM_CONFIG__ = undefined;
  process.env.VITE_PLATFORM_MODE = "true";
  useLockfileStore.setState({ lockfile: null, committed: false });
  localStorage.removeItem(LOCKFILE_STORAGE_KEY);
  localStorage.removeItem(SELECTED_ASSISTANT_STORAGE_KEY);
  replacePlatformAssistantsHost.mockClear();
  saveLockfileAssistantHost.mockClear();
});

describe("remote gateway mode", () => {
  test("loads a synthetic active assistant without calling the local host", async () => {
    window.__VELLUM_CONFIG__ = { mode: "remote-gateway" };

    const lockfile = await loadLockfile();

    expect(isRemoteGatewayMode()).toBe(true);
    expect(loadLockfileHost).not.toHaveBeenCalled();
    expect(lockfile.activeAssistant).toBe("self");
    expect(lockfile.assistants).toEqual([
      expect.objectContaining({
        assistantId: "self",
        cloud: "local",
        name: "Local Assistant",
        runtimeUrl: window.location.origin,
      }),
    ]);
    expect(getLocalAssistants().map((a) => a.assistantId)).toEqual(["self"]);
    expect(getLocalGatewayUrl()).toBeUndefined();
    expect(useLockfileStore.getState().committed).toBe(true);
  });
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
      expect.objectContaining({
        assistantId: "platform-a",
        organizationId: "org-1",
      }),
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

describe("updateLockfileAssistant", () => {
  test("patches an existing entry without changing the active assistant", async () => {
    setLockfile({ assistants: [localA], activeAssistant: "local-a" });
    saveLockfileAssistantHost.mockImplementationOnce(async (entry) => ({
      ok: true as const,
      lockfile: {
        assistants: [entry as LockfileAssistant],
        activeAssistant: "local-a",
      },
    }));

    await updateLockfileAssistant("local-a", {
      platformAssistantId: "platform-asst-1",
      platformBaseUrl: "https://platform.example.com",
      platformOrganizationId: "org_1",
    });

    expect(saveLockfileAssistantHost).toHaveBeenCalledWith(
      {
        ...localA,
        platformAssistantId: "platform-asst-1",
        platformBaseUrl: "https://platform.example.com",
        platformOrganizationId: "org_1",
      },
      undefined,
    );
    expect(getLockfile().activeAssistant).toBe("local-a");
    expect(getLockfile().assistants[0]).toEqual(
      expect.objectContaining({
        platformAssistantId: "platform-asst-1",
      }),
    );
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

  test("a local-cloud entry with a gateway port is local, not platform", () => {
    expect(isLocalAssistant(localA)).toBe(true);
    expect(isPlatformAssistant(localA)).toBe(false);
  });

  test("a local-cloud entry without a gateway port is still local (identity, not connectivity)", () => {
    const portless = { assistantId: "x", cloud: "local" } as LockfileAssistant;
    expect(isLocalAssistant(portless)).toBe(true);
    expect(isPlatformAssistant(portless)).toBe(false);
  });

  test("externally-managed container runtimes are not web-client local", () => {
    // Docker and apple-container have no `resources` in the web lockfile and are
    // managed by the CLI / macOS app, not the web client's local flows — so
    // restart/retire/logout routing must keep treating them as non-local.
    const docker = { assistantId: "d", cloud: "docker" } as LockfileAssistant;
    const appleContainer = {
      assistantId: "a",
      cloud: "apple-container",
    } as LockfileAssistant;
    expect(isLocalAssistant(docker)).toBe(false);
    expect(isLocalAssistant(appleContainer)).toBe(false);
  });

  test("a legacy entry with no cloud normalizes to local at the parse seam", () => {
    // Entries that predate the `cloud` field are normalized to "local" by
    // parseLockfile (see @vellumai/local-mode/contract), so by the time one
    // reaches isLocalAssistant its cloud is already set.
    const { assistants } = parseLockfile({
      assistants: [{ assistantId: "old" }],
      activeAssistant: null,
    });
    expect(isLocalAssistant(assistants[0]!)).toBe(true);
  });

  test("remote self-hosted clouds are neither local nor platform", () => {
    for (const cloud of ["paired", "gcp", "aws", "custom"]) {
      const remote = { assistantId: `r-${cloud}`, cloud } as LockfileAssistant;
      expect(isLocalAssistant(remote)).toBe(false);
      expect(isPlatformAssistant(remote)).toBe(false);
    }
  });

  test("getLocalAssistants / getPlatformAssistants partition by cloud, excluding remote", () => {
    const paired = {
      assistantId: "paired-a",
      cloud: "paired",
    } as LockfileAssistant;
    setLockfile({
      assistants: [localA, platform, paired],
      activeAssistant: null,
    });
    expect(getLocalAssistants()).toEqual([localA]);
    expect(getPlatformAssistants()).toEqual([platform]);
  });
});

describe("getLocalGatewayUrl", () => {
  test("resolves the gateway proxy URL for a local assistant with a recorded port", () => {
    enableLocalMode();
    expect(getLocalGatewayUrl(localA)).toBe("/assistant/__gateway/7830");
  });

  test("is undefined for a local assistant with no recorded gateway port", () => {
    enableLocalMode();
    const portless = { assistantId: "x", cloud: "local" } as LockfileAssistant;
    expect(getLocalGatewayUrl(portless)).toBeUndefined();
  });

  test("is undefined for a platform assistant", () => {
    enableLocalMode();
    expect(getLocalGatewayUrl(platform)).toBeUndefined();
  });

  test("is undefined for a remote (paired) assistant", () => {
    enableLocalMode();
    const paired = { assistantId: "p", cloud: "paired" } as LockfileAssistant;
    expect(getLocalGatewayUrl(paired)).toBeUndefined();
  });

  test("is undefined outside local mode even for a local assistant with a port", () => {
    expect(getLocalGatewayUrl(localA)).toBeUndefined();
  });
});

describe("isCliWakeableAssistant", () => {
  test("a cloud:local entry with no recorded port is wakeable (wake establishes it)", () => {
    setLockfile({
      assistants: [
        { assistantId: "legacy", cloud: "local" } as LockfileAssistant,
      ],
      activeAssistant: "legacy",
    });
    expect(isCliWakeableAssistant("legacy")).toBe(true);
  });

  test("a legacy (cloud-less) entry is wakeable once normalized at parse", () => {
    setLockfile(
      parseLockfile({
        assistants: [{ assistantId: "old" }],
        activeAssistant: "old",
      }),
    );
    expect(isCliWakeableAssistant("old")).toBe(true);
  });

  test("a docker-cloud entry is not CLI-wakeable", () => {
    setLockfile({
      assistants: [{ assistantId: "dk", cloud: "docker" } as LockfileAssistant],
      activeAssistant: "dk",
    });
    expect(isCliWakeableAssistant("dk")).toBe(false);
  });

  test("a platform (vellum) entry is not CLI-wakeable", () => {
    setLockfile({ assistants: [platform], activeAssistant: "platform-a" });
    expect(isCliWakeableAssistant("platform-a")).toBe(false);
  });

  test("an unknown id is not wakeable", () => {
    setLockfile({ assistants: [localA], activeAssistant: "local-a" });
    expect(isCliWakeableAssistant("nope")).toBe(false);
  });
});

describe("primeLocalGatewayConnection", () => {
  test("throws UnresolvedLocalGatewayError for a local assistant with no resolved gateway", async () => {
    enableLocalMode();
    const portless = {
      assistantId: "legacy",
      cloud: "local",
    } as LockfileAssistant;
    await expect(primeLocalGatewayConnection(portless)).rejects.toBeInstanceOf(
      UnresolvedLocalGatewayError,
    );
  });

  test("is a no-op for a platform assistant even in local mode", async () => {
    enableLocalMode();
    await expect(
      primeLocalGatewayConnection(platform),
    ).resolves.toBeUndefined();
  });

  test("is a no-op for a remote (paired) assistant — not a local gateway case", async () => {
    enableLocalMode();
    const paired = { assistantId: "p", cloud: "paired" } as LockfileAssistant;
    await expect(primeLocalGatewayConnection(paired)).resolves.toBeUndefined();
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

    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBeNull();
    expect(getSelectedAssistant()).toBe(localA);
  });

  test("preserves a selection that is still present in the lockfile", () => {
    setLockfile({ assistants: [localA, localB], activeAssistant: "local-a" });
    setSelected("local-b");

    reconcileSelectedAssistant();

    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBe(
      "local-b",
    );
    expect(getSelectedAssistant()).toBe(localB);
  });

  test("is a no-op when there is no tab-local selection", () => {
    setLockfile({ assistants: [localA], activeAssistant: "local-a" });

    reconcileSelectedAssistant();

    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBeNull();
  });

  test("a transient empty-lockfile read does not clear the selection", () => {
    // No cached lockfile and nothing persisted → getLockfile() hits its empty
    // fallback (setCachedLockfile), which must NOT reconcile. Otherwise a boot/
    // read failure would wrongly drop a still-valid selection.
    setSelected("local-a");

    getLockfile();

    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBe(
      "local-a",
    );
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
