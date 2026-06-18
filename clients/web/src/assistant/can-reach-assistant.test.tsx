import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { AssistantState } from "@/assistant/types";
import type { LockfileAssistant } from "@/lib/local-mode";
import type { PlatformSessionStatus } from "@/stores/session-status";

// Hosting-mode functions read runtime config (injected globals, env), so drive
// them off plain flags the tests set per-case — matching the pure predicate
// test's mock style. Spread the real module so the auth-store dependency graph
// (pulled in transitively by the hook) keeps every other `@/lib/local-mode`
// export; only the four functions the predicate branches on are overridden.
let mockIsLocalMode = true;
let mockIsRemoteGatewayMode = false;

const localModeActual = await import("@/lib/local-mode");

mock.module("@/lib/local-mode", () => ({
  ...localModeActual,
  isLocalMode: () => mockIsLocalMode,
  isRemoteGatewayMode: () => mockIsRemoteGatewayMode,
  isLocalAssistant: (a: {
    cloud?: string;
    resources?: { gatewayPort?: number };
  }) => a.cloud !== "vellum" && a.resources?.gatewayPort != null,
  isPlatformAssistant: (a: { cloud?: string }) => a.cloud === "vellum",
}));

const { useCanReachAssistant } = await import("@/assistant/can-reach-assistant");
const { useAssistantLifecycleStore } = await import(
  "@/assistant/lifecycle-store"
);
const { useAuthStore } = await import("@/stores/auth-store");

const initialLifecycleState = useAssistantLifecycleStore.getState();
const initialAuthState = useAuthStore.getState();

const localAssistant: LockfileAssistant = {
  assistantId: "local-a",
  cloud: "local",
  resources: { gatewayPort: 51234, daemonPort: 51235 },
};

const platformAssistant: LockfileAssistant = {
  assistantId: "platform-a",
  cloud: "vellum",
};

function setLifecycle(assistantState: AssistantState): void {
  act(() => {
    useAssistantLifecycleStore.setState(
      { ...initialLifecycleState, assistantState },
      true,
    );
  });
}

function setPlatformSession(platformSession: PlatformSessionStatus): void {
  act(() => {
    useAuthStore.setState({ ...initialAuthState, platformSession }, true);
  });
}

beforeEach(() => {
  mockIsLocalMode = true;
  mockIsRemoteGatewayMode = false;
  useAssistantLifecycleStore.setState(initialLifecycleState, true);
  useAuthStore.setState(initialAuthState, true);
});

afterEach(() => {
  cleanup();
});

describe("useCanReachAssistant", () => {
  describe("local assistant in local mode", () => {
    test("reachable when lifecycle settled a healthy self_hosted connection", () => {
      setLifecycle({ kind: "self_hosted", health: "healthy" });
      const { result } = renderHook(() => useCanReachAssistant(localAssistant));
      expect(result.current).toBe(true);
    });

    test("reachable when lifecycle is active + local and not flagged unreachable", () => {
      setLifecycle({ kind: "active", isLocal: true, reachable: true });
      const { result } = renderHook(() => useCanReachAssistant(localAssistant));
      expect(result.current).toBe(true);
    });

    test.each<AssistantState>([
      { kind: "loading" },
      { kind: "initializing" },
      { kind: "self_hosted", health: "unreachable" },
      { kind: "active", isLocal: true, reachable: false },
      { kind: "active", isLocal: true, health: "unreachable" },
      { kind: "error", message: "boom" },
    ])("unreachable for lifecycle state %o", (state) => {
      setLifecycle(state);
      const { result } = renderHook(() => useCanReachAssistant(localAssistant));
      expect(result.current).toBe(false);
    });

    test("re-renders to reachable when the lifecycle connection resolves", () => {
      setLifecycle({ kind: "initializing" });
      const { result } = renderHook(() => useCanReachAssistant(localAssistant));
      expect(result.current).toBe(false);

      setLifecycle({ kind: "self_hosted", health: "healthy" });
      expect(result.current).toBe(true);
    });

    // A platform session for THIS assistant must not stand in for the local
    // connection: a local assistant is reachable only off its lifecycle state.
    test("platformSession does not make a local assistant reachable", () => {
      setLifecycle({ kind: "self_hosted", health: "unreachable" });
      setPlatformSession("present");
      const { result } = renderHook(() => useCanReachAssistant(localAssistant));
      expect(result.current).toBe(false);
    });
  });

  describe("remote-gateway mode", () => {
    beforeEach(() => {
      mockIsLocalMode = false;
      mockIsRemoteGatewayMode = true;
    });

    test("reachable when the lifecycle resolved a healthy connection", () => {
      setLifecycle({ kind: "self_hosted", health: "healthy" });
      const { result } = renderHook(() => useCanReachAssistant(localAssistant));
      expect(result.current).toBe(true);
    });

    test("unreachable before the lifecycle resolves", () => {
      setLifecycle({ kind: "loading" });
      const { result } = renderHook(() => useCanReachAssistant(localAssistant));
      expect(result.current).toBe(false);
    });
  });

  describe("platform-hosted assistant", () => {
    beforeEach(() => {
      mockIsLocalMode = false;
    });

    test("reachable when the platform session is present", () => {
      setPlatformSession("present");
      const { result } = renderHook(() =>
        useCanReachAssistant(platformAssistant),
      );
      expect(result.current).toBe(true);
    });

    test.each<PlatformSessionStatus>(["absent", "unknown"])(
      "unreachable when platformSession is %s",
      (status) => {
        setPlatformSession(status);
        const { result } = renderHook(() =>
          useCanReachAssistant(platformAssistant),
        );
        expect(result.current).toBe(false);
      },
    );

    test("re-renders when the platform session changes", () => {
      setPlatformSession("absent");
      const { result } = renderHook(() =>
        useCanReachAssistant(platformAssistant),
      );
      expect(result.current).toBe(false);

      setPlatformSession("present");
      expect(result.current).toBe(true);
    });

    // The lifecycle connection signal must not stand in for a platform session:
    // a resolved local lifecycle cannot make a platform assistant reachable.
    test("lifecycle connection does not make a platform assistant reachable", () => {
      setLifecycle({ kind: "self_hosted", health: "healthy" });
      setPlatformSession("absent");
      const { result } = renderHook(() =>
        useCanReachAssistant(platformAssistant),
      );
      expect(result.current).toBe(false);
    });
  });
});
