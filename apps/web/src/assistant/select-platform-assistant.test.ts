/**
 * Unit tests for `selectPlatformAssistant` — the single primitive both the
 * settings picker and (later) the tray use to switch the active assistant. It
 * records the one selection (the source the lifecycle re-resolves from) and
 * mirrors it into the lockfile for the tray/CLI/native.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const setSelectedAssistantMock = mock((_id: string | null) => {});
const setActiveLockfileAssistantMock = mock(async (_id: string) => {});

mock.module("@/lib/local-mode", () => ({
  setActiveLockfileAssistant: setActiveLockfileAssistantMock,
  getActiveAssistant: () => undefined,
}));
mock.module("@/stores/resolved-assistants-store", () => ({
  assistantsValidForOrg: () => [],
  useResolvedAssistantsStore: {
    getState: () => ({
      setSelectedAssistant: setSelectedAssistantMock,
      assistants: [],
      selectedAssistantId: null,
      assistantsHydrated: true,
    }),
  },
}));

const { selectPlatformAssistant } = await import("./select-platform-assistant");

beforeEach(() => {
  setSelectedAssistantMock.mockClear();
  setActiveLockfileAssistantMock.mockClear();
});

describe("selectPlatformAssistant", () => {
  test("records the selection and mirrors it into the lockfile", async () => {
    await selectPlatformAssistant("ast-2");
    expect(setSelectedAssistantMock).toHaveBeenCalledWith("ast-2");
    expect(setActiveLockfileAssistantMock).toHaveBeenCalledWith("ast-2");
  });
});
