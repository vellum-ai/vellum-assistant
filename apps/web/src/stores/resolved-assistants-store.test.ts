import { beforeEach, describe, expect, it } from "bun:test";

import {
  assistantsValidForOrg,
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";
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
  useResolvedAssistantsStore.setState({ assistants: [] });
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
