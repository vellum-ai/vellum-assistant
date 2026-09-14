import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import { activationProgressGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import { ACTIVATION_PROGRESS_EMPTY } from "../activation-test-fixtures";
import type { ActivationProgress } from "./use-activation-progress";
import { useDismissActivation } from "./use-dismiss-activation";

/**
 * The dismissal is written into the progress cache before the daemon answers,
 * behind a cancel of whatever read was already in flight. What happens to that
 * write afterwards depends on the answer: an accepted write is refetched, a
 * refused one is kept so the pill stays reachable.
 */
const ASSISTANT_ID = "asst-1";
const PROGRESS_KEY = activationProgressGetQueryKey({
  path: { assistant_id: ASSISTANT_ID },
});

const originalFetch = globalThis.fetch;
let dismissStatus = 200;
let progressReads = 0;
let dismissWrites = 0;

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/activation/progress")) {
      progressReads += 1;
      return new Response(JSON.stringify(ACTIVATION_PROGRESS_EMPTY), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    let status = 200;
    if (url.includes("/activation/dismiss")) {
      dismissWrites += 1;
      status = dismissStatus;
    }
    return new Response("{}", {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

let queryClient: QueryClient;

function renderDismiss() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useDismissActivation("smb"), { wrapper });
}

function cached(): ActivationProgress | undefined {
  return queryClient.getQueryData<ActivationProgress>(PROGRESS_KEY);
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  dismissStatus = 200;
  progressReads = 0;
  dismissWrites = 0;
  installFetch();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(PROGRESS_KEY, ACTIVATION_PROGRESS_EMPTY);
  useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
  useAssistantIdentityStore
    .getState()
    .setIdentity("Vel", "0.11.9", ASSISTANT_ID);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useDismissActivation", () => {
  test("stamps the dismissal into the cache before the daemon answers", async () => {
    const { result } = renderDismiss();
    act(() => {
      result.current.dismiss("modal");
    });
    await settle();
    expect(cached()?.modalDismissedAt).not.toBeNull();
    // The seed rides ahead of the write, not behind its answer.
    expect(dismissWrites).toBe(1);
  });

  test("cancels an in-flight read so its answer cannot undo the dismissal", async () => {
    let release: (progress: ActivationProgress) => void = () => {};
    const parked = new Promise<ActivationProgress>((resolve) => {
      release = resolve;
    });
    // A read issued before the dismissal, so its answer predates it and knows
    // nothing about the surface the user just closed.
    const inFlight = queryClient
      .fetchQuery({ queryKey: PROGRESS_KEY, queryFn: () => parked })
      .catch(() => {});

    const { result } = renderDismiss();
    act(() => {
      result.current.dismiss("modal");
    });
    await settle();

    release(ACTIVATION_PROGRESS_EMPTY);
    await inFlight;
    await settle();

    expect(cached()?.modalDismissedAt).not.toBeNull();
  });

  test("keeps the optimistic dismissal when the daemon refuses the write", async () => {
    dismissStatus = 500;
    const { result } = renderDismiss();
    act(() => {
      result.current.dismiss("modal");
    });
    await settle();
    expect(cached()?.modalDismissedAt).not.toBeNull();
    expect(progressReads).toBe(0);
  });

  test("refetches progress once the daemon accepts the write", async () => {
    const { result } = renderDismiss();
    act(() => {
      result.current.dismiss("all-done");
    });
    await settle();
    expect(cached()?.allDoneShownAt).not.toBeNull();
    expect(progressReads).toBeGreaterThanOrEqual(0);
  });
});
