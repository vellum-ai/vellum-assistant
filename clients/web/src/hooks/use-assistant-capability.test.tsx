import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

let supported: boolean | undefined = true;
let failed = false;
let deferred = false;
let finishHealth: (() => void) | undefined;
let orgReady = true;
let assistantId: string | null = "assistant-1";
const health = mock(async () => {
  if (deferred) {
    await new Promise<void>((resolve) => {
      finishHealth = resolve;
    });
  }
  return failed
    ? { ok: false, status: 503, error: { message: "Unavailable" } }
    : {
        ok: true,
        status: 200,
        data: { capabilities: { chatsSettings: supported } },
      };
});
mock.module("@/assistant/api", () => ({ getAssistantHealthz: health }));
mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));
mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: { use: { activeAssistantId: () => assistantId } },
}));
const { useAssistantCapabilityQuery } =
  await import("./use-assistant-capability");
let client: QueryClient;
beforeEach(() => {
  supported = true;
  failed = false;
  deferred = false;
  finishHealth = undefined;
  orgReady = true;
  assistantId = "assistant-1";
  health.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
});
function mount() {
  return renderHook(
    () => {
      const query = useAssistantCapabilityQuery("chatsSettings");
      return {
        data: query.data,
        isPending: query.isPending,
        isSuccess: query.isSuccess,
        isError: query.isError,
        refetch: query.refetch,
      };
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
}

test("keeps unknown support pending until health responds", async () => {
  deferred = true;
  const hook = mount();
  expect(hook.result.current.isPending).toBe(true);
  expect(hook.result.current.data).toBeUndefined();
  await act(async () => {
    finishHealth?.();
  });
  await waitFor(() => expect(hook.result.current.data).toBe(true));
});

for (const value of [false, undefined]) {
  test(`a successful health response confirms unsupported when capability is ${value}`, async () => {
    supported = value;
    const hook = mount();
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    expect(hook.result.current.data).toBe(false);
  });
}

test("a failed health read is retryable without confirming unsupported", async () => {
  failed = true;
  const hook = mount();
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(hook.result.current.data).toBeUndefined();
  failed = false;
  await act(() => hook.result.current.refetch());
  await waitFor(() => expect(hook.result.current.data).toBe(true));
});

test("retains confirmed support when a background health refresh fails", async () => {
  const hook = mount();
  await waitFor(() => expect(hook.result.current.data).toBe(true));
  failed = true;
  await act(() => hook.result.current.refetch());
  await waitFor(() => expect(hook.result.current.isError).toBe(true));
  expect(hook.result.current.data).toBe(true);
});

test("waits for both an assistant and organization readiness", async () => {
  orgReady = false;
  const hook = mount();
  expect(health).not.toHaveBeenCalled();
  orgReady = true;
  assistantId = null;
  hook.rerender();
  expect(health).not.toHaveBeenCalled();
  assistantId = "assistant-1";
  hook.rerender();
  await waitFor(() => expect(hook.result.current.data).toBe(true));
  expect(health).toHaveBeenCalledWith("assistant-1");
});
