import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

mock.module("@/generated/daemon/sdk.gen", () => ({
  configGet: mock(async () => ({ data: daemonConfig })),
  configPatch: async () => {
    await configPatchMock();
    return { data: daemonConfig };
  },
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
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
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
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

  test("hides memory settings when the assistant does not report opt-out support", () => {
    memoryOptOutCapability = false;

    renderWithQuery(<AdvancedPage />);

    expect(screen.queryByText("Memory")).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Enable memory" }),
    ).toBeNull();
  });
});
