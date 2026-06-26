import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { AssistantState } from "@/assistant/types";

const sdkMock = mock(async (): Promise<{
  data: Record<string, unknown> | null;
  error: unknown;
  response: Response;
}> => ({
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
const recordLifecycleDiagnosticMock = mock(
  (_kind: string, _details: Record<string, unknown>) => {},
);
let sseConnectedSnapshotMock = false;

mock.module("@/generated/api/sdk.gen", () => ({
  assistantsOperationalStatusDetailRead: sdkMock,
}));

mock.module("@/lib/diagnostics", () => ({
  recordLifecycleDiagnostic: recordLifecycleDiagnosticMock,
}));

mock.module("@/stores/sse-connected-store", () => ({
  getSSEConnectedSnapshot: () => sseConnectedSnapshotMock,
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
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

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
  recordLifecycleDiagnosticMock.mockClear();
  sseConnectedSnapshotMock = false;
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
  useResolvedAssistantsStore.setState({
    assistants: [],
    activeAssistantId: null,
    selectedAssistantId: null,
    assistantsHydrated: false,
  });
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

  test("fetches for known platform-hosted assistants while lifecycle is loading", async () => {
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "assistant-platform",
          isLocal: false,
          isPlatformHosted: true,
        },
      ],
      selectedAssistantId: "assistant-platform",
      assistantsHydrated: true,
    });
    setLifecycle({ kind: "loading" });

    renderHook(() => useAssistantOperationalStatus("assistant-platform"), {
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

  test("records a vembda_unreachable transition with the live-SSE flag", async () => {
    // GIVEN the data plane is healthy (events still flowing) but the
    // control plane can't reach vembda to confirm status.
    sseConnectedSnapshotMock = true;
    sdkMock.mockImplementationOnce(async () => ({
      data: {
        state: "unreachable",
        detail_state: "vembda_unreachable",
        poll_after_ms: 10000,
        updated_at: "2026-06-19T19:47:07Z",
        state_started_at: null,
        active_operation: null,
        assistant: {
          id: "assistant-platform",
          status: "active",
          machine_id: "m-1",
          vembda_cluster_id: "vembda-assistant-0",
        },
        pod: {
          statefulset_found: null,
          spec_replicas: null,
          ready_replicas: null,
          pod_name: null,
          pod_phase: null,
          has_restart_history: false,
          max_restart_count: null,
          fatal_reason: null,
        },
        runtime: { healthz_ok: false, assistant_version: null, checked_at: null },
        storage: null,
        detail: {
          reason: "vembda_unreachable",
          message: "Could not reach vembda for assistant status.",
        },
      },
      error: undefined,
      response: new Response(null, { status: 200 }),
    }));
    setLifecycle({ kind: "active", isLocal: false });

    renderHook(() => useAssistantOperationalStatus("assistant-platform"), {
      wrapper,
    });

    await waitFor(() => {
      expect(recordLifecycleDiagnosticMock).toHaveBeenCalledWith(
        "operational_status",
        expect.objectContaining({
          state: "unreachable",
          detailState: "vembda_unreachable",
          reason: "vembda_unreachable",
          message: "Could not reach vembda for assistant status.",
          healthzOk: false,
          sseConnected: true,
        }),
      );
    });
  });

  test("does not re-record an unchanged operational status signature", async () => {
    setLifecycle({ kind: "active", isLocal: false });

    const { rerender } = renderHook(
      () => useAssistantOperationalStatus("assistant-stable"),
      { wrapper },
    );

    await waitFor(() => {
      expect(recordLifecycleDiagnosticMock).toHaveBeenCalledTimes(1);
    });

    // A second resolve of the same active/"" signature must not append a
    // duplicate lifecycle entry.
    rerender();
    await settleQueries();

    expect(recordLifecycleDiagnosticMock).toHaveBeenCalledTimes(1);
  });
});
