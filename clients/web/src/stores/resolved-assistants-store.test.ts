import { beforeEach, describe, expect, it } from "bun:test";

import {
  assistantsValidForOrg,
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";
import { SELECTED_ASSISTANT_STORAGE_KEY } from "@/assistant/selected-assistant-storage";
import { useLockfileStore } from "@/stores/lockfile-store";
import type { Lockfile, LockfileAssistant } from "@/runtime/local-mode-host";

// A platform entry is identified by `cloud === "vellum"` and carries an
// `organizationId`; a local entry has a non-vellum cloud + gateway port and no org.
const platformAssistant: LockfileAssistant = {
  assistantId: "asst-platform",
  name: "Platform",
  cloud: "vellum",
  organizationId: "org-1",
};

const localAssistant: LockfileAssistant = {
  assistantId: "asst-local",
  name: "Local",
  cloud: "local",
  resources: {
    gatewayPort: 7830,
    daemonPort: 7831,
    runtimeVersion: "v0.8.13",
  },
};

const otherLocalAssistant: LockfileAssistant = {
  assistantId: "asst-other",
  name: "Other Local",
  cloud: "local",
  resources: {
    gatewayPort: 7930,
    daemonPort: 7931,
    runtimeVersion: "v0.8.12",
  },
};

beforeEach(() => {
  localStorage.removeItem(SELECTED_ASSISTANT_STORAGE_KEY);
  useLockfileStore.setState({ lockfile: null, committed: false });
  useResolvedAssistantsStore.setState({
    assistants: [],
    selectedAssistantId: null,
    assistantsHydrated: false,
  });
});

describe("setFromLockfile", () => {
  it("copies organizationId for platform entries", () => {
    const lockfile: Lockfile = {
      assistants: [platformAssistant],
      activeAssistant: "asst-platform",
    };
    useResolvedAssistantsStore.getState().setFromLockfile(lockfile);

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.id).toBe("asst-platform");
    expect(entry.cloud).toBe("vellum");
    expect(entry.isPlatformHosted).toBe(true);
    expect(entry.organizationId).toBe("org-1");
    expect(entry.isActiveLockfileAssistant).toBe(true);
  });

  it("preserves API-seeded release metadata for platform entries", () => {
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "asst-platform",
          isLocal: false,
          isPlatformHosted: true,
          currentReleaseVersion: "0.9.0",
          releaseChannel: "preview",
        },
      ],
    });

    useResolvedAssistantsStore.getState().setFromLockfile({
      assistants: [platformAssistant],
      activeAssistant: "asst-platform",
    });

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.currentReleaseVersion).toBe("0.9.0");
    expect(entry.releaseChannel).toBe("preview");
  });

  it("copies Bun-local fields for local entries", () => {
    const lockfile: Lockfile = {
      assistants: [localAssistant],
      activeAssistant: "asst-local",
    };
    useResolvedAssistantsStore.getState().setFromLockfile(lockfile);

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.id).toBe("asst-local");
    expect(entry.cloud).toBe("local");
    expect(entry.isLocal).toBe(true);
    expect(entry.organizationId).toBeUndefined();
    expect(entry.runtimeVersion).toBe("v0.8.13");
    expect(entry.isActiveLockfileAssistant).toBe(true);
  });

  it("marks local entries inactive when the lockfile active pointer differs", () => {
    const lockfile: Lockfile = {
      assistants: [localAssistant, otherLocalAssistant],
      activeAssistant: "asst-other",
    };
    useResolvedAssistantsStore.getState().setFromLockfile(lockfile);

    const [entry, otherEntry] = useResolvedAssistantsStore.getState().assistants;
    expect(entry?.id).toBe("asst-local");
    expect(entry?.cloud).toBe("local");
    expect(entry?.isActiveLockfileAssistant).toBe(false);
    expect(otherEntry?.id).toBe("asst-other");
    expect(otherEntry?.isActiveLockfileAssistant).toBe(true);
  });

  it("treats a sole local entry as active when the lockfile active pointer is empty", () => {
    const lockfile: Lockfile = {
      assistants: [localAssistant],
      activeAssistant: null,
    };
    useResolvedAssistantsStore.getState().setFromLockfile(lockfile);

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.id).toBe("asst-local");
    expect(entry.cloud).toBe("local");
    expect(entry.isActiveLockfileAssistant).toBe(true);
  });

  it("treats a sole local entry as active when the lockfile active pointer is stale", () => {
    const lockfile: Lockfile = {
      assistants: [localAssistant],
      activeAssistant: "asst-stale",
    };
    useResolvedAssistantsStore.getState().setFromLockfile(lockfile);

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.id).toBe("asst-local");
    expect(entry.cloud).toBe("local");
    expect(entry.isActiveLockfileAssistant).toBe(true);
  });
});

describe("upsertFromApi", () => {
  it("hydrates lockfile fields when replacing the list from the API", () => {
    useLockfileStore.getState().setLockfile({
      assistants: [localAssistant],
      activeAssistant: "asst-local",
    });

    useResolvedAssistantsStore.getState().setFromApi([
      {
        id: "asst-local",
        name: "Local",
        created: "2026-01-01T00:00:00Z",
        is_local: true,
        current_release_version: "0.9.0",
        release_channel: "stable",
      } as Parameters<
        ReturnType<typeof useResolvedAssistantsStore.getState>["setFromApi"]
      >[0][number],
    ]);

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.id).toBe("asst-local");
    expect(entry.cloud).toBe("local");
    expect(entry.runtimeVersion).toBe("v0.8.13");
    expect(entry.currentReleaseVersion).toBe("0.9.0");
    expect(entry.releaseChannel).toBe("stable");
    expect(entry.isActiveLockfileAssistant).toBe(true);
    expect(entry.organizationId).toBeUndefined();
  });

  it("preserves a lockfile-seeded organizationId on refresh (API has no org)", () => {
    useResolvedAssistantsStore.getState().setFromLockfile({
      assistants: [platformAssistant],
      activeAssistant: null,
    });

    // A lifecycle refresh upserts the API-shaped payload, which carries no org.
    useResolvedAssistantsStore.getState().upsertFromApi({
      id: "asst-platform",
      name: "Platform (refreshed)",
      created: "2026-01-01T00:00:00Z",
      is_local: false,
      current_release_version: "0.10.0",
      release_channel: "preview",
    } as Parameters<
      ReturnType<typeof useResolvedAssistantsStore.getState>["upsertFromApi"]
    >[0]);

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.id).toBe("asst-platform");
    expect(entry.name).toBe("Platform (refreshed)");
    expect(entry.organizationId).toBe("org-1");
    expect(entry.currentReleaseVersion).toBe("0.10.0");
    expect(entry.releaseChannel).toBe("preview");
  });

  it("preserves a lockfile-seeded runtimeVersion on refresh", () => {
    useResolvedAssistantsStore.getState().setFromLockfile({
      assistants: [localAssistant],
      activeAssistant: "asst-local",
    });

    useResolvedAssistantsStore.getState().upsertFromApi({
      id: "asst-local",
      name: "Local (refreshed)",
      created: "2026-01-01T00:00:00Z",
      is_local: true,
    } as Parameters<
      ReturnType<typeof useResolvedAssistantsStore.getState>["upsertFromApi"]
    >[0]);

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.id).toBe("asst-local");
    expect(entry.name).toBe("Local (refreshed)");
    expect(entry.cloud).toBe("local");
    expect(entry.runtimeVersion).toBe("v0.8.13");
    expect(entry.isActiveLockfileAssistant).toBe(true);
  });

  it("seeds lockfile fields from the cache when inserting a new entry", () => {
    // A lifecycle refresh can land before the lockfile subscription has seeded
    // the resolved list; the insert must still pick up the fields the lockfile knows.
    useLockfileStore.getState().setLockfile({
      assistants: [platformAssistant, localAssistant],
      activeAssistant: "asst-local",
    });

    useResolvedAssistantsStore.getState().upsertFromApi({
      id: "asst-platform",
      name: "Platform",
      created: "2026-01-01T00:00:00Z",
      is_local: false,
    } as Parameters<
      ReturnType<typeof useResolvedAssistantsStore.getState>["upsertFromApi"]
    >[0]);

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.id).toBe("asst-platform");
    expect(entry.cloud).toBe("vellum");
    expect(entry.organizationId).toBe("org-1");
    expect(entry.isActiveLockfileAssistant).toBe(false);

    useResolvedAssistantsStore.getState().upsertFromApi({
      id: "asst-local",
      name: "Local",
      created: "2026-01-01T00:00:00Z",
      is_local: true,
    } as Parameters<
      ReturnType<typeof useResolvedAssistantsStore.getState>["upsertFromApi"]
    >[0]);

    const localEntry = useResolvedAssistantsStore.getState().assistants[1];
    expect(localEntry.id).toBe("asst-local");
    expect(localEntry.cloud).toBe("local");
    expect(localEntry.runtimeVersion).toBe("v0.8.13");
    expect(localEntry.isActiveLockfileAssistant).toBe(true);
  });
});

describe("assistantsValidForOrg", () => {
  const local: ResolvedAssistant = {
    id: "local",
    isLocal: true,
    isPlatformHosted: false,
  };
  const activeOrg: ResolvedAssistant = {
    id: "active-org",
    isLocal: false,
    isPlatformHosted: true,
    organizationId: "org-1",
  };
  const otherOrg: ResolvedAssistant = {
    id: "other-org",
    isLocal: false,
    isPlatformHosted: true,
    organizationId: "org-2",
  };
  const legacy: ResolvedAssistant = {
    id: "legacy",
    isLocal: false,
    isPlatformHosted: true,
  };

  it("always keeps local entries", () => {
    expect(assistantsValidForOrg([local], "org-1")).toEqual([local]);
    expect(assistantsValidForOrg([local], null)).toEqual([local]);
  });

  it("keeps platform entries only when owned by the active org", () => {
    const result = assistantsValidForOrg([activeOrg, otherOrg], "org-1");
    expect(result).toEqual([activeOrg]);
  });

  it("keeps legacy entries with no org (undefined)", () => {
    expect(assistantsValidForOrg([legacy], "org-1")).toEqual([legacy]);
  });

  it("drops cross-org platform entries", () => {
    expect(assistantsValidForOrg([otherOrg], "org-1")).toEqual([]);
  });
});

describe("setSelectedAssistant", () => {
  it("moves the reactive slice and the persisted key together", () => {
    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-1");
    expect(useResolvedAssistantsStore.getState().selectedAssistantId).toBe(
      "asst-1",
    );
    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBe("asst-1");

    useResolvedAssistantsStore.getState().setSelectedAssistant(null);
    expect(useResolvedAssistantsStore.getState().selectedAssistantId).toBeNull();
    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBeNull();
  });
});

describe("selection reconcile on hydration", () => {
  it("clears a selection absent from the lockfile (the ghost case)", () => {
    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-ghost");
    useResolvedAssistantsStore.getState().setFromLockfile({
      assistants: [localAssistant],
      activeAssistant: null,
    });
    expect(useResolvedAssistantsStore.getState().selectedAssistantId).toBeNull();
    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBeNull();
  });

  it("preserves a selection still present in the lockfile", () => {
    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-local");
    useResolvedAssistantsStore.getState().setFromLockfile({
      assistants: [localAssistant],
      activeAssistant: null,
    });
    expect(useResolvedAssistantsStore.getState().selectedAssistantId).toBe(
      "asst-local",
    );
  });

  it("does NOT clear a cross-org selection on the org-scoped API list", () => {
    // setFromApi reflects only the active org's assistants; a selection for a
    // different org must survive (it's filtered on read, never deleted here).
    const apiEntry = {
      id: "asst-active-org",
      name: "Active",
      created: "2026-01-01T00:00:00Z",
      is_local: false,
    } as Parameters<
      ReturnType<typeof useResolvedAssistantsStore.getState>["upsertFromApi"]
    >[0];
    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-other-org");
    useResolvedAssistantsStore.getState().setFromApi([apiEntry]);
    expect(useResolvedAssistantsStore.getState().selectedAssistantId).toBe(
      "asst-other-org",
    );
  });
});
