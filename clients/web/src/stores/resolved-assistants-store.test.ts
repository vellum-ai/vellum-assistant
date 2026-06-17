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
  resources: { gatewayPort: 7830, daemonPort: 7831 },
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
      activeAssistant: null,
    };
    useResolvedAssistantsStore.getState().setFromLockfile(lockfile);

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.id).toBe("asst-platform");
    expect(entry.isPlatformHosted).toBe(true);
    expect(entry.organizationId).toBe("org-1");
  });

  it("leaves organizationId undefined for local entries", () => {
    const lockfile: Lockfile = {
      assistants: [localAssistant],
      activeAssistant: null,
    };
    useResolvedAssistantsStore.getState().setFromLockfile(lockfile);

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.id).toBe("asst-local");
    expect(entry.isLocal).toBe(true);
    expect(entry.organizationId).toBeUndefined();
  });
});

describe("upsertFromApi", () => {
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
    } as Parameters<
      ReturnType<typeof useResolvedAssistantsStore.getState>["upsertFromApi"]
    >[0]);

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.id).toBe("asst-platform");
    expect(entry.name).toBe("Platform (refreshed)");
    expect(entry.organizationId).toBe("org-1");
  });

  it("seeds organizationId from the lockfile cache when inserting a new entry", () => {
    // A lifecycle refresh can land before the lockfile subscription has seeded
    // the resolved list; the insert must still pick up the org the lockfile knows.
    useLockfileStore.getState().setLockfile({
      assistants: [platformAssistant],
      activeAssistant: null,
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
    expect(entry.organizationId).toBe("org-1");
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
