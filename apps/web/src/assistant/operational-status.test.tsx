import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { AssistantState } from "@/assistant/types";

const sdkMock = mock(async () => ({
  data: {
    state: "active",
    detail_state: "",
    poll_after_ms: 5000,
    updated_at: "2026-06-10T00:00:00Z",
    state_started_at: null,
    active_operation: null,
    assistant: { id: "a-1", status: "active", machine_id: null, vembda_cluster_id: null },
    pod: { phase: "Running", ready: true, container_state: "running", restart_count: 0, checked_at: null },
    runtime: { version: "1.0.0", release_channel: "stable" },
    storage: null,
    detail: { reason: null, message: null },
  },
  error: undefined,
  response: new Response(null, { status: 200 }),
}));
const isLocalModeMock = mock(() => false);
const isPlatformDisabledMock = mock(() => false);
let isOrgReadyMock = true;

mock.module("@/generated/api/sdk.gen", () => ({
  assistantsOperationalStatusDetailRead: sdkMock,
}));

mock.module("@/lib/local-mode", () => ({
  isLocalMode: isLocalModeMock,
  isPlatformDisabled: isPlatformDisabledMock,
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => isOrgReadyMock,
}));

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import { useAssistantOperationalStatus } from "@/assistant/operational-status";
import { useAuthStore } from "@/stores/auth-store";

const initialAuthState = useAuthStore.getState();
const initialLifecycleState = useAssistantLifecycleStore.getState();

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return createElement(QueryClientProvider, { client: queryClient }, children);
}

function setLifecycle(
  assistantState: AssistantState,
  operationalStatusAssistantId: string | null = null,
) {
  useAssistantLifecycleStore.setState(
    {
      ...initialLifecycleState,
      assistantState,
      operationalStatusAssistantId,
    },
    true,
  );
}

async function settleQueries() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  sdkMock.mockClear();
  isLocalModeMock.mockImplementation(() => false);
  isPlatformDisabledMock.mockImplementation(() => false);
  isOrgReadyMock = true;
  useAuthStore.setState(
    {
      ...initialAuthState,
      platformSession: "present",
    },
    true,
  );
  useAssistantLifecycleStore.setState(initialLifecycleState, true);
});

afterEach(() => {
  cleanup();
});

describe("useAssistantOperationalStatus", () => {
  test("does not fetch for active local assistants", async () => {
    setLifecycle({ kind: "active", isLocal: true });

    renderHook(() => useAssistantOperationalStatus("assistant-local"), {
      wrapper,
    });
    await settleQueries();

    expect(sdkMock).not.toHaveBeenCalled();
  });

  test("fetches for active platform-hosted assistants", async () => {
    setLifecycle({ kind: "active", isLocal: false });

    renderHook(() => useAssistantOperationalStatus("assistant-platform"), {
      wrapper,
    });

    await waitFor(() => {
      expect(sdkMock).toHaveBeenCalledTimes(1);
    });
  });

  test("fetches for lifecycle-owned platform operation ids during transitional states", async () => {
    setLifecycle({ kind: "initializing" }, "assistant-operation");

    renderHook(() => useAssistantOperationalStatus("assistant-operation"), {
      wrapper,
    });

    await waitFor(() => {
      expect(sdkMock).toHaveBeenCalledTimes(1);
    });
  });

  test("does not fetch during unresolved loading without a lifecycle operation id", async () => {
    setLifecycle({ kind: "loading" });

    renderHook(() => useAssistantOperationalStatus("assistant-unknown"), {
      wrapper,
    });
    await settleQueries();

    expect(sdkMock).not.toHaveBeenCalled();
  });
});
