import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

let daemonConfig: { memory?: { enabled?: boolean } } | undefined;
let memoryOptOutCapability = true;
const configPatchMock = mock(async () => daemonConfig);

mock.module("@/domains/settings/components/assistant-status-panel", () => ({
  useAssistantWithHealthz: () => ({
    assistant: { id: "assistant-1", is_local: true },
    healthz: memoryOptOutCapability
      ? { capabilities: { memoryOptOut: true } }
      : { capabilities: {} },
  }),
}));

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "hidden",
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

function usageRow(callSiteId: string, label: string, costUsd: number) {
  return {
    group: label,
    groupId: callSiteId,
    groupKey: callSiteId,
    totalInputTokens: 100,
    totalOutputTokens: 10,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalEstimatedCostUsd: costUsd,
    eventCount: 1,
  };
}

mock.module("@/generated/daemon/sdk.gen", () => ({
  configGet: mock(async () => ({ data: daemonConfig })),
  configPatch: async () => {
    await configPatchMock();
    return { data: daemonConfig };
  },
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  configLlmCallsitesGetOptions: (options: { path: { assistant_id: string } }) => ({
    queryKey: [{ _id: "configLlmCallsitesGet", path: options.path }],
    queryFn: async () => ({
      domains: [{ id: "memory", displayName: "Memory" }],
      callSites: [
        {
          id: "memoryRetrospective",
          displayName: "Memory Retrospective",
          description: "",
          domain: "memory",
        },
        { id: "recall", displayName: "Recall", description: "", domain: "memory" },
        {
          id: "mainAgent",
          displayName: "Main Agent",
          description: "",
          domain: "agentLoop",
        },
      ],
    }),
  }),
  usageBreakdownGetOptions: (options: {
    path: { assistant_id: string };
    query: { from: number; to: number; groupBy: string };
  }) => ({
    queryKey: [
      { _id: "usageBreakdownGet", path: options.path, query: options.query },
    ],
    queryFn: async () => ({
      breakdown: [
        usageRow("memoryRetrospective", "Memory Retrospective", 0.25),
        // recall stays available when memory is off, so it must not count.
        usageRow("recall", "Recall", 5),
        usageRow("mainAgent", "Main Agent", 10),
      ],
    }),
  }),
  configGetQueryKey: (options: { path: { assistant_id: string } }) => [
    { _id: "configGet", baseUrl: undefined, path: options.path },
  ],
  configGetOptions: (options: { path: { assistant_id: string } }) => ({
    queryKey: [{ _id: "configGet", baseUrl: undefined, path: options.path }],
    queryFn: async () => daemonConfig,
  }),
  configGetSetQueryData: (_client: unknown, _opts: unknown, _data: unknown) => {},
  useConfigPatchMutation: () => ({
    mutateAsync: async (_opts: { body: unknown }) => {
      await configPatchMock();
      return { data: daemonConfig };
    },
    isPending: false,
  }),
}));

const { configGetQueryKey } = await import("@/generated/daemon/@tanstack/react-query.gen");
const { AdvancedPage } = await import("./advanced-page");

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  const queryKey = configGetQueryKey({ path: { assistant_id: "assistant-1" } });
  queryClient.setQueryData(queryKey, daemonConfig);
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  daemonConfig = { memory: { enabled: true } };
  memoryOptOutCapability = true;
  configPatchMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("AdvancedPage memory settings", () => {
  test("shows memory enabled by default and patches memory.enabled off", async () => {
    renderWithQuery(<AdvancedPage />);

    expect(screen.getByText("Memory")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Enable memory" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(configPatchMock).toHaveBeenCalled(),
    );
  });

  test("treats missing memory.enabled as enabled and can patch it off", async () => {
    daemonConfig = {};
    renderWithQuery(<AdvancedPage />);

    const toggle = screen.getByRole("switch", { name: "Enable memory" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(configPatchMock).toHaveBeenCalled(),
    );
  });

  test("shows the toggle-gated memory cost for the last 30 days", async () => {
    renderWithQuery(<AdvancedPage />);

    expect(screen.getByText("Cost in the last 30 days")).toBeTruthy();
    // Only memory-domain spend gated by the toggle: retrospective ($0.25),
    // not recall ($5) or the main agent ($10).
    await waitFor(() => expect(screen.getByText("$0.25")).toBeTruthy());
    expect(screen.getByRole("link", { name: /View usage/ })).toBeTruthy();
  });

  test("hides memory settings when the assistant does not report opt-out support", () => {
    memoryOptOutCapability = false;

    renderWithQuery(<AdvancedPage />);

    expect(screen.queryByText("Memory")).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Enable memory" }),
    ).toBeNull();
  });
});
