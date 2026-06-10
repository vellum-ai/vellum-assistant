/**
 * Unit tests for `resolveSelectedAssistantId` — the unified read path shared by
 * platform and local selection. Covers the resolution order: valid per-org
 * cache hit → drop wrong-org → lockfile activeAssistant → first valid → unknown
 * id pass-through.
 *
 * bun's `mock.module` is process-global, so this file must run on its own.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { assistantsValidForOrg } from "@/stores/resolved-assistants-store";
import type { ResolvedAssistant } from "@/stores/resolved-assistants-store";
import type { LockfileAssistant } from "@/runtime/local-mode-host";

const ORG_A = "org-a";
const ORG_B = "org-b";

// Mutable fixtures the mocks read so each test can stage its own world.
let assistants: ResolvedAssistant[] = [];
let selectedPlatformAssistantByOrg: Record<string, string> = {};
let selectedLocal: LockfileAssistant | undefined;
let activeLocal: LockfileAssistant | undefined;

mock.module("@/stores/resolved-assistants-store", () => ({
  assistantsValidForOrg,
  useResolvedAssistantsStore: {
    getState: () => ({ assistants, selectedPlatformAssistantByOrg }),
  },
}));
mock.module("@/lib/local-mode", () => ({
  getSelectedAssistant: () => selectedLocal,
  getActiveAssistant: () => activeLocal,
  setActiveLockfileAssistant: async () => {},
}));
mock.module("@/stores/organization-store", () => ({
  useOrganizationStore: { getState: () => ({ currentOrganizationId: ORG_A }) },
}));

const { resolveSelectedAssistantId } = await import("./selection");

function platformAssistant(
  id: string,
  organizationId?: string,
): ResolvedAssistant {
  return { id, isLocal: false, isPlatformHosted: true, organizationId };
}

function lockfileAssistant(assistantId: string): LockfileAssistant {
  return {
    assistantId,
    cloud: "vellum",
    runtimeUrl: "http://x",
    hatchedAt: "2026-01-01",
  } as LockfileAssistant;
}

beforeEach(() => {
  assistants = [];
  selectedPlatformAssistantByOrg = {};
  selectedLocal = undefined;
  activeLocal = undefined;
});

describe("resolveSelectedAssistantId", () => {
  test("valid cached per-org selection passes through", () => {
    assistants = [platformAssistant("asst-1", ORG_A)];
    selectedPlatformAssistantByOrg = { [ORG_A]: "asst-1" };
    expect(resolveSelectedAssistantId(ORG_A)).toBe("asst-1");
  });

  test("wrong-org cached selection is dropped and falls back", () => {
    // asst-b is owned by ORG_B; asst-a is the only valid one for ORG_A.
    assistants = [
      platformAssistant("asst-b", ORG_B),
      platformAssistant("asst-a", ORG_A),
    ];
    selectedPlatformAssistantByOrg = { [ORG_A]: "asst-b" };
    expect(resolveSelectedAssistantId(ORG_A)).toBe("asst-a");
  });

  test("empty cache falls back to lockfile activeAssistant when valid", () => {
    assistants = [platformAssistant("asst-1", ORG_A)];
    activeLocal = lockfileAssistant("asst-1");
    expect(resolveSelectedAssistantId(ORG_A)).toBe("asst-1");
  });

  test("empty cache + stale active falls back to first valid assistant", () => {
    assistants = [platformAssistant("asst-1", ORG_A)];
    // active id no longer resolves to a valid entry for this org.
    activeLocal = lockfileAssistant("asst-stale");
    expect(resolveSelectedAssistantId(ORG_A)).toBe("asst-1");
  });

  test("unknown candidate id (no resolved entry) passes through", () => {
    assistants = [platformAssistant("asst-1", ORG_A)];
    selectedPlatformAssistantByOrg = { [ORG_A]: "asst-unknown" };
    expect(resolveSelectedAssistantId(ORG_A)).toBe("asst-unknown");
  });
});
