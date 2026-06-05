/**
 * Unit tests for `selectPlatformAssistant` — the single primitive both the
 * settings picker and (later) the tray use to switch the active platform
 * assistant. It records the per-org selection (the source the lifecycle
 * re-resolves from) and mirrors it into the lockfile for the tray/CLI/native.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let orgId: string | null = "org-1";

const setAssistantIdMock = mock((_orgId: string, _id: string | null) => {});
const setActiveLockfileAssistantMock = mock(async (_id: string) => {});

mock.module("@/lib/local-mode", () => ({
  setActiveLockfileAssistant: setActiveLockfileAssistantMock,
}));
mock.module("@/stores/current-platform-assistant-store", () => ({
  useCurrentPlatformAssistantStore: {
    getState: () => ({ setAssistantId: setAssistantIdMock }),
  },
}));
mock.module("@/stores/organization-store", () => ({
  useOrganizationStore: {
    getState: () => ({ currentOrganizationId: orgId }),
  },
}));

const { selectPlatformAssistant } = await import("./select-platform-assistant");

beforeEach(() => {
  orgId = "org-1";
  setAssistantIdMock.mockClear();
  setActiveLockfileAssistantMock.mockClear();
});

describe("selectPlatformAssistant", () => {
  test("records the per-org selection and mirrors it into the lockfile", async () => {
    await selectPlatformAssistant("ast-2");
    expect(setAssistantIdMock).toHaveBeenCalledWith("org-1", "ast-2");
    expect(setActiveLockfileAssistantMock).toHaveBeenCalledWith("ast-2");
  });

  test("skips the per-org write when there is no current org but still mirrors the lockfile", async () => {
    orgId = null;
    await selectPlatformAssistant("ast-2");
    expect(setAssistantIdMock).not.toHaveBeenCalled();
    expect(setActiveLockfileAssistantMock).toHaveBeenCalledWith("ast-2");
  });
});
