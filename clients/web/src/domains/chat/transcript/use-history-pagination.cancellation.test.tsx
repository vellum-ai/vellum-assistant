import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import { useHistoryPagination } from "./use-history-pagination";

interface CapturedHistoryRequest {
  signal: AbortSignal | null | undefined;
}

let originalFetch: typeof fetch;
let requests: CapturedHistoryRequest[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  requests = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    const signal = input instanceof Request ? input.signal : init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      requests.push({ signal });
      const rejectAbort = () =>
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) {
        rejectAbort();
      } else {
        signal?.addEventListener("abort", rejectAbort, { once: true });
      }
    });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useHistoryPagination cancellation", () => {
  test("aborts the obsolete request without surfacing or retrying it", async () => {
    const queryClient = new QueryClient();
    const view = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useHistoryPagination({
          assistantId: "assistant-123",
          conversationId,
          enabled: true,
        }),
      {
        initialProps: { conversationId: "conversation-123" },
        wrapper: createWrapper(queryClient),
      },
    );
    await waitFor(() => expect(requests).toHaveLength(1));

    view.rerender({ conversationId: "conversation-456" });

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]!.signal?.aborted).toBe(true);
    expect(requests[1]!.signal?.aborted).toBe(false);
    expect(view.result.current.isError).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requests).toHaveLength(2);

    view.unmount();
    queryClient.clear();
  });
});
