import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { DaemonConfigPatch } from "@/domains/settings/ai/ai-types";

let daemonConfig: { memory?: { enabled?: boolean } } | undefined;
const mutateAsyncMock = mock(async (_patch: DaemonConfigPatch) => ({}));

mock.module("@/domains/settings/components/assistant-status-panel", () => ({
  useAssistantWithHealthz: () => ({
    assistant: { id: "assistant-1", is_local: true },
  }),
}));

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "hidden",
}));

mock.module("@/domains/settings/ai/use-daemon-config", () => ({
  useDaemonConfigQuery: () => ({
    config: daemonConfig,
  }),
  useDaemonConfigMutation: () => ({
    mutateAsync: mutateAsyncMock,
    isPending: false,
  }),
}));

const { AdvancedPage } = await import("./advanced-page");

beforeEach(() => {
  daemonConfig = { memory: { enabled: true } };
  mutateAsyncMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("AdvancedPage memory settings", () => {
  test("shows memory enabled by default and patches memory.enabled off", async () => {
    render(<AdvancedPage />);

    expect(screen.getByText("Memory")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Enable memory" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mutateAsyncMock).toHaveBeenCalledWith({
        memory: { enabled: false },
      }),
    );
  });

  test("treats missing memory.enabled as enabled and can patch it off", async () => {
    daemonConfig = {};
    render(<AdvancedPage />);

    const toggle = screen.getByRole("switch", { name: "Enable memory" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(mutateAsyncMock).toHaveBeenCalledWith({
        memory: { enabled: false },
      }),
    );
  });
});
