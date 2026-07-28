import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

// Stub the login hook so importing the page doesn't pull the auth-store →
// assistant/api → daemon SDK chain into this unit test (the gate is mocked to
// a non-"disabled" value, so PlatformLoginNotice never renders here anyway).
mock.module("@/hooks/use-onboarding-login", () => ({
  useOnboardingLogin: () => ({
    loading: false,
    error: null,
    login: mock(async () => {}),
    cancel: mock(() => {}),
  }),
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

// The worker toggle has its own unit test (memory-worker-toggle.test.tsx); stub
// it here so these tests stay focused on the memory.enabled control and don't
// need the worker status/start/stop query mocks.
mock.module("@/domains/settings/components/memory-worker-toggle", () => ({
  MemoryWorkerToggle: ({ memoryEnabled }: { memoryEnabled: boolean }) => (
    <div
      data-testid="memory-worker-toggle"
      data-memory-enabled={memoryEnabled}
    />
  ),
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
  configGetSetQueryData: (
    _client: unknown,
    _opts: unknown,
    _data: unknown,
  ) => {},
  useConfigPatchMutation: () => ({
    mutateAsync: async (_opts: { body: unknown }) => {
      await configPatchMock();
      return { data: daemonConfig };
    },
    isPending: false,
  }),
}));

const { configGetQueryKey } =
  await import("@/generated/daemon/@tanstack/react-query.gen");
const { MemoryCard } = await import("./memory-card");

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

describe("MemoryCard memory settings", () => {
  test("shows memory enabled by default and patches memory.enabled off", async () => {
    renderWithQuery(<MemoryCard />);

    expect(screen.getByText("Memory")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Enable memory" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    // The background-worker sub-control renders inside the memory card and is
    // told memory is currently enabled.
    const workerToggle = screen.getByTestId("memory-worker-toggle");
    expect(workerToggle.getAttribute("data-memory-enabled")).toBe("true");

    fireEvent.click(toggle);

    await waitFor(() => expect(configPatchMock).toHaveBeenCalled());
  });

  test("treats missing memory.enabled as enabled and can patch it off", async () => {
    daemonConfig = {};
    renderWithQuery(<MemoryCard />);

    const toggle = screen.getByRole("switch", { name: "Enable memory" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);

    await waitFor(() => expect(configPatchMock).toHaveBeenCalled());
  });

  test("hides memory settings when the assistant does not report opt-out support", () => {
    memoryOptOutCapability = false;

    renderWithQuery(<MemoryCard />);

    expect(screen.queryByText("Memory")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Enable memory" })).toBeNull();
  });
});
