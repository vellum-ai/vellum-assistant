import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type WorkerStatus = {
  status: "running" | "not_running";
  workerEnabled: boolean;
  syncRunner: { status: "running" | "not_running" };
  embedding: {
    enabled: boolean;
    degraded: boolean;
    provider: null;
    model: null;
    reason: null;
  };
} | null;

let workerStatus: WorkerStatus;
const startMock = mock(async () => ({ workerEnabled: true }));
const stopMock = mock(async () => ({ workerEnabled: false }));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  memoryWorkerStatusGetOptions: (options: { path: { assistant_id: string } }) => ({
    queryKey: [{ _id: "memoryWorkerStatusGet", path: options.path }],
    queryFn: async () => {
      if (!workerStatus) throw new Error("not found");
      return workerStatus;
    },
  }),
  memoryWorkerStatusGetSetQueryData: (
    _client: unknown,
    _opts: unknown,
    _updater: unknown,
  ) => {},
  useMemoryWorkerStartPostMutation: (
    opts?: { onSuccess?: (data: unknown) => void },
  ) => ({
    mutateAsync: async (_args: unknown) => {
      const result = await startMock();
      opts?.onSuccess?.(result);
      return result;
    },
    isPending: false,
  }),
  useMemoryWorkerStopPostMutation: (
    opts?: { onSuccess?: (data: unknown) => void },
  ) => ({
    mutateAsync: async (_args: unknown) => {
      const result = await stopMock();
      opts?.onSuccess?.(result);
      return result;
    },
    isPending: false,
  }),
}));

const { MemoryWorkerToggle } = await import("./memory-worker-toggle");

function makeStatus(workerEnabled: boolean): WorkerStatus {
  return {
    status: workerEnabled ? "running" : "not_running",
    workerEnabled,
    syncRunner: { status: workerEnabled ? "not_running" : "running" },
    embedding: {
      enabled: true,
      degraded: false,
      provider: null,
      model: null,
      reason: null,
    },
  };
}

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  workerStatus = makeStatus(false);
  startMock.mockClear();
  stopMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("MemoryWorkerToggle", () => {
  test("renders off and starts the worker when toggled on", async () => {
    renderWithQuery(<MemoryWorkerToggle memoryEnabled={true} />);

    const toggle = await screen.findByRole("switch", {
      name: "Enable background memory worker",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    await waitFor(() => expect(startMock).toHaveBeenCalled());
    expect(stopMock).not.toHaveBeenCalled();
  });

  test("renders on and stops the worker when toggled off", async () => {
    workerStatus = makeStatus(true);
    renderWithQuery(<MemoryWorkerToggle memoryEnabled={true} />);

    const toggle = await screen.findByRole("switch", {
      name: "Enable background memory worker",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);

    await waitFor(() => expect(stopMock).toHaveBeenCalled());
    expect(startMock).not.toHaveBeenCalled();
  });

  test("disables the toggle when memory is off", async () => {
    renderWithQuery(<MemoryWorkerToggle memoryEnabled={false} />);

    const toggle = await screen.findByRole("switch", {
      name: "Enable background memory worker",
    });
    expect(toggle.hasAttribute("disabled")).toBe(true);

    fireEvent.click(toggle);
    expect(startMock).not.toHaveBeenCalled();
    expect(stopMock).not.toHaveBeenCalled();
  });

  test("hides the row when worker status is unavailable", async () => {
    workerStatus = null;
    renderWithQuery(<MemoryWorkerToggle memoryEnabled={true} />);

    await waitFor(() =>
      expect(
        screen.queryByRole("switch", {
          name: "Enable background memory worker",
        }),
      ).toBeNull(),
    );
  });
});
