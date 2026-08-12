import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { AssistantState } from "@/assistant/types";

const sdkMock = mock(
  async (): Promise<{
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
      assistant: {
        id: "a-1",
        status: "active",
        machine_id: null,
        vembda_cluster_id: null,
      },
      pod: {
        phase: "Running",
        ready: true,
        container_state: "running",
        restart_count: 0,
        checked_at: null,
      },
      runtime: { version: "1.0.0", release_channel: "stable" },
      storage: null,
      detail: { reason: null, message: null },
    },
    error: undefined,
    response: new Response(null, { status: 200 }),
  }),
);
const isLocalClientMock = mock(() => false);
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
  isLocalClient: isLocalClientMock,
  isPlatformDisabled: isPlatformDisabledMock,
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => isOrgReadyMock,
}));

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import {
  isServingOperationalStatus,
  useAssistantIsServing,
  useAssistantOperationalStatus,
} from "@/assistant/operational-status";
import type { OperationalStatus } from "@/generated/api/types.gen";
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
  isLocalClientMock.mockImplementation(() => false);
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
          isPaired: false,
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
        runtime: {
          healthz_ok: false,
          assistant_version: null,
          checked_at: null,
        },
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

/**
 * The gate that decides whether daemon queries may run.
 *
 * "Not known to be down" rather than "healthy" is the question, because
 * operational status is a platform-only signal and is absent for every
 * assistant whose health lives somewhere else. A gate that read absence as
 * "down" would strand them behind a signal that never arrives.
 */
describe("isServingOperationalStatus", () => {
  function status(state: string): OperationalStatus {
    return { state } as OperationalStatus;
  }

  test("opens when the pod is active", () => {
    expect(isServingOperationalStatus(status("active"))).toBe(true);
  });

  test("closes while the pod is waking", () => {
    // The case this exists for: the daemon 503s every request through the wake
    // window while the assistant record still reads `active`.
    expect(isServingOperationalStatus(status("waking"))).toBe(false);
  });

  test("closes for every state where the daemon cannot answer", () => {
    for (const state of [
      "sleeping",
      "initializing",
      "provisioning",
      "migrating",
      "restarting",
      "restoring_backup",
      "upgrading_assistant_version",
      "resizing_machine",
      "resizing_storage",
      "maintenance_mode",
      "crash_loop",
      "not_found",
      "retiring",
    ]) {
      expect(isServingOperationalStatus(status(state))).toBe(false);
    }
  });

  test("stays open when the control plane cannot reach the pod", () => {
    // `unreachable` is the control plane failing to confirm reachability, not
    // evidence the pod is down. Paired with a live SSE connection it is this
    // module's split-brain fingerprint: daemon requests succeed while the
    // status pipeline cannot see the pod. Closing here would blank the sidebar
    // of an assistant that is answering perfectly well.
    expect(isServingOperationalStatus(status("unreachable"))).toBe(true);
  });

  test("stays open for a state this client's schema predates", () => {
    // `state` is an open string on the wire. A platform that adds one must not
    // silently lock every client below it out of its own conversations.
    expect(isServingOperationalStatus(status("some_future_state"))).toBe(true);
  });

  test("opens when status is absent", () => {
    // `null` is a local/self-hosted assistant, a non-`full` platform gate, or a
    // 403/404. `undefined` is the window before the first poll resolves.
    // Closing on either would block assistants that never report here at all,
    // and would put the status poll in front of every cold load.
    expect(isServingOperationalStatus(null)).toBe(true);
    expect(isServingOperationalStatus(undefined)).toBe(true);
  });
});

describe("useAssistantIsServing", () => {
  test("is open for a local assistant, which never reports status", async () => {
    setLifecycle({ kind: "active", isLocal: true });

    const { result } = renderHook(
      () => useAssistantIsServing("assistant-local"),
      { wrapper },
    );
    await settleQueries();

    expect(sdkMock).not.toHaveBeenCalled();
    expect(result.current).toBe(true);
  });

  test("closes while a platform-hosted pod is waking", async () => {
    setLifecycle({ kind: "active", isLocal: false });
    sdkMock.mockImplementation(async () => ({
      data: { state: "waking", detail_state: "pod_pending" },
      error: undefined,
      response: new Response(null, { status: 200 }),
    }));

    const { result } = renderHook(
      () => useAssistantIsServing("assistant-waking"),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  test("reopens when the pod finishes waking", async () => {
    // The recovery edge. A list query gated on this is refetched by TanStack
    // Query when the flag flips back to true, which is what carries a sidebar
    // out of a failed load once the pod comes up.
    setLifecycle({ kind: "active", isLocal: false });
    let podState = "waking";
    sdkMock.mockImplementation(async () => ({
      data: { state: podState, detail_state: "", poll_after_ms: 1000 },
      error: undefined,
      response: new Response(null, { status: 200 }),
    }));

    const { result } = renderHook(
      () => useAssistantIsServing("assistant-recovering"),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current).toBe(false);
    });

    podState = "active";

    // Generous relative to the 1s floor on the poll interval, so the reopen
    // has room to land on a slow machine rather than racing the default 1s
    // `waitFor` budget.
    await waitFor(
      () => {
        expect(result.current).toBe(true);
      },
      { timeout: 5000 },
    );
  });
});
