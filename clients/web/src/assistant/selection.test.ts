/**
 * Unit tests for `resolveSelectedAssistantId` — the unified read path shared by
 * platform and local selection. There is ONE selection; the org is a read-time
 * filter. Covers the resolution order: valid selected id → drop wrong-org →
 * lockfile activeAssistant → first valid, plus the hydration-gated pass-through
 * for an unknown id.
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
let selectedAssistantId: string | null = null;
let assistantsHydrated = true;
let activeLocal: LockfileAssistant | undefined;

const storeSetSelectedAssistantMock = mock((_id: string | null) => {});
mock.module("@/stores/resolved-assistants-store", () => ({
  assistantsValidForOrg,
  useResolvedAssistantsStore: {
    getState: () => ({
      assistants,
      selectedAssistantId,
      assistantsHydrated,
      setSelectedAssistant: storeSetSelectedAssistantMock,
    }),
  },
}));
const setActiveLockfileAssistantMock = mock(async (_id: string) => {});
mock.module("@/lib/local-mode", () => ({
  getActiveAssistant: () => activeLocal,
  setActiveLockfileAssistant: setActiveLockfileAssistantMock,
}));

const { resolveSelectedAssistantId, setSelectedAssistant } = await import(
  "./selection"
);

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
  selectedAssistantId = null;
  assistantsHydrated = true;
  activeLocal = undefined;
  storeSetSelectedAssistantMock.mockClear();
  setActiveLockfileAssistantMock.mockClear();
});

describe("resolveSelectedAssistantId", () => {
  test("valid selected id passes through", () => {
    assistants = [platformAssistant("asst-1", ORG_A)];
    selectedAssistantId = "asst-1";
    expect(resolveSelectedAssistantId(ORG_A)).toBe("asst-1");
  });

  test("wrong-org selection is dropped and falls back", () => {
    // asst-b is owned by ORG_B; asst-a is the only valid one for ORG_A.
    assistants = [
      platformAssistant("asst-b", ORG_B),
      platformAssistant("asst-a", ORG_A),
    ];
    selectedAssistantId = "asst-b";
    expect(resolveSelectedAssistantId(ORG_A)).toBe("asst-a");
  });

  test("empty selection falls back to lockfile activeAssistant when valid", () => {
    assistants = [platformAssistant("asst-1", ORG_A)];
    activeLocal = lockfileAssistant("asst-1");
    expect(resolveSelectedAssistantId(ORG_A)).toBe("asst-1");
  });

  test("empty selection + stale active falls back to first valid assistant", () => {
    assistants = [platformAssistant("asst-1", ORG_A)];
    // active id no longer resolves to a valid entry for this org.
    activeLocal = lockfileAssistant("asst-stale");
    expect(resolveSelectedAssistantId(ORG_A)).toBe("asst-1");
  });

  test("unknown selected id passes through while NOT hydrated (pre-load)", () => {
    // The list may simply not have arrived yet, so don't drop the selection.
    assistantsHydrated = false;
    assistants = [];
    selectedAssistantId = "asst-unknown";
    expect(resolveSelectedAssistantId(ORG_A)).toBe("asst-unknown");
  });

  test("unknown selected id is a ghost once hydrated and falls through", () => {
    // Regression for the ghost bug: a hydrated list that doesn't contain the
    // selection means it's genuinely gone — fall through, never return it.
    assistantsHydrated = true;
    assistants = [platformAssistant("asst-1", ORG_A)];
    selectedAssistantId = "asst-unknown";
    expect(resolveSelectedAssistantId(ORG_A)).toBe("asst-1");
  });

  test("hydrated unknown selection with no valid assistants resolves to null", () => {
    assistantsHydrated = true;
    assistants = [];
    selectedAssistantId = "asst-unknown";
    expect(resolveSelectedAssistantId(ORG_A)).toBeNull();
  });

  test("a stale lockfile active with no resolved entry is NOT passed through", () => {
    // Regression: the lockfile active must go through validation, not the
    // unknown-id pass-through — otherwise a stale active 404-loops forever.
    assistants = [platformAssistant("asst-1", ORG_A)];
    activeLocal = lockfileAssistant("asst-stale");
    expect(resolveSelectedAssistantId(ORG_A)).toBe("asst-1");
  });
});

describe("setSelectedAssistant", () => {
  test("an id records the selection and mirrors it into the lockfile", async () => {
    await setSelectedAssistant("asst-1");

    expect(storeSetSelectedAssistantMock).toHaveBeenCalledWith("asst-1");
    expect(setActiveLockfileAssistantMock).toHaveBeenCalledWith("asst-1");
  });

  test("null clears the selection and skips the lockfile mirror", async () => {
    await setSelectedAssistant(null);

    expect(storeSetSelectedAssistantMock).toHaveBeenCalledWith(null);
    expect(setActiveLockfileAssistantMock).not.toHaveBeenCalled();
  });
});
