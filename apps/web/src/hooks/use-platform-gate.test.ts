import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

const isLocalModeMock = mock(() => false);
mock.module("@/lib/local-mode", () => ({
  isLocalMode: isLocalModeMock,
}));

import { useAuthStore } from "@/stores/auth-store";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import type { AssistantState } from "@/assistant/types";
import { usePlatformGate } from "@/hooks/use-platform-gate";

const initialAuthState = useAuthStore.getState();
const initialFlagState = useAssistantFeatureFlagStore.getState();
const initialLifecycleState = useAssistantLifecycleStore.getState();

function setLifecycle(assistantState: AssistantState) {
  useAssistantLifecycleStore.setState({ assistantState });
}

beforeEach(() => {
  isLocalModeMock.mockImplementation(() => false);
  useAuthStore.setState(initialAuthState, true);
  useAssistantFeatureFlagStore.setState(initialFlagState, true);
  useAssistantLifecycleStore.setState(initialLifecycleState, true);
});

afterEach(() => {
  cleanup();
});

describe("usePlatformGate — default (standard pattern)", () => {
  test('returns "full" when platform-hosted and logged in', () => {
    useAuthStore.setState({ hasPlatformSession: true });
    const { result } = renderHook(() => usePlatformGate());
    expect(result.current).toBe("full");
  });

  test('returns "disabled" when platform-hosted and not logged in', () => {
    useAuthStore.setState({ hasPlatformSession: false });
    const { result } = renderHook(() => usePlatformGate());
    expect(result.current).toBe("disabled");
  });

  test('returns "disabled" in local mode before flag hydration', () => {
    isLocalModeMock.mockImplementation(() => true);
    useAuthStore.setState({ hasPlatformSession: true });
    useAssistantFeatureFlagStore.setState({ hasHydrated: false });
    const { result } = renderHook(() => usePlatformGate());
    expect(result.current).toBe("disabled");
  });

  test('returns "full" in local mode when hydrated, logged in, and flag ON', () => {
    isLocalModeMock.mockImplementation(() => true);
    useAuthStore.setState({ hasPlatformSession: true });
    useAssistantFeatureFlagStore.setState({
      hasHydrated: true,
      platformFeaturesInLocalMode: true,
    } as Partial<ReturnType<typeof useAssistantFeatureFlagStore.getState>>);
    const { result } = renderHook(() => usePlatformGate());
    expect(result.current).toBe("full");
  });

  test('returns "gated" in local mode when platform features flag is OFF', () => {
    isLocalModeMock.mockImplementation(() => true);
    useAuthStore.setState({ hasPlatformSession: true });
    useAssistantFeatureFlagStore.setState({
      hasHydrated: true,
      platformFeaturesInLocalMode: false,
    } as Partial<ReturnType<typeof useAssistantFeatureFlagStore.getState>>);
    const { result } = renderHook(() => usePlatformGate());
    expect(result.current).toBe("gated");
  });
});

describe("usePlatformGate — { platformHostedOnly: true }", () => {
  test('returns "full" when lifecycle resolves to active+platform-hosted and logged in', () => {
    setLifecycle({ kind: "active", isLocal: false });
    useAuthStore.setState({ hasPlatformSession: true });
    const { result } = renderHook(() =>
      usePlatformGate({ platformHostedOnly: true }),
    );
    expect(result.current).toBe("full");
  });

  test('returns "disabled" when lifecycle resolves to active+platform-hosted and NOT logged in', () => {
    setLifecycle({ kind: "active", isLocal: false });
    useAuthStore.setState({ hasPlatformSession: false });
    const { result } = renderHook(() =>
      usePlatformGate({ platformHostedOnly: true }),
    );
    expect(result.current).toBe("disabled");
  });

  test('returns "gated" when lifecycle resolves to self_hosted (any app mode)', () => {
    // The "platform mode + self-hosted assistant" case: API returns
    // is_local: true, lifecycle projects { kind: "self_hosted" }.
    setLifecycle({ kind: "self_hosted" });
    useAuthStore.setState({ hasPlatformSession: true });
    const { result } = renderHook(() =>
      usePlatformGate({ platformHostedOnly: true }),
    );
    expect(result.current).toBe("gated");
  });

  test('returns "gated" when lifecycle resolves to active+isLocal (gateway-auth short-circuit)', () => {
    // The local-mode gateway-auth short-circuit path:
    // lifecycle-service.applyGatewayAuthShortCircuit transitions to
    // { kind: "active", isLocal: true }.
    isLocalModeMock.mockImplementation(() => true);
    setLifecycle({ kind: "active", isLocal: true });
    useAuthStore.setState({ hasPlatformSession: true });
    const { result } = renderHook(() =>
      usePlatformGate({ platformHostedOnly: true }),
    );
    expect(result.current).toBe("gated");
  });

  test('returns "full" in local-mode app when active assistant is platform-hosted (logged in)', () => {
    // A local-mode app can be managing a platform-hosted assistant.
    // The lifecycle service projects { kind: "active", isLocal: false }
    // in that case — platform-hosted-only UI IS meaningful here.
    isLocalModeMock.mockImplementation(() => true);
    setLifecycle({ kind: "active", isLocal: false });
    useAuthStore.setState({ hasPlatformSession: true });
    const { result } = renderHook(() =>
      usePlatformGate({ platformHostedOnly: true }),
    );
    expect(result.current).toBe("full");
  });

  test('ignores platformFeaturesInLocalMode flag when active assistant is platform-hosted', () => {
    // The flag gates the daemon-side API interceptor in local mode —
    // it has no bearing on UI that targets a platform-hosted assistant.
    isLocalModeMock.mockImplementation(() => true);
    setLifecycle({ kind: "active", isLocal: false });
    useAuthStore.setState({ hasPlatformSession: true });
    useAssistantFeatureFlagStore.setState({
      hasHydrated: true,
      platformFeaturesInLocalMode: false,
    } as Partial<ReturnType<typeof useAssistantFeatureFlagStore.getState>>);
    const { result } = renderHook(() =>
      usePlatformGate({ platformHostedOnly: true }),
    );
    expect(result.current).toBe("full");
  });

  test('does not gate on hydration state for platform-hosted-only branch', () => {
    // Pre-hydration in local mode used to return "disabled" via the
    // standard fall-through. The platform-hosted-only branch must
    // bypass the hydration check entirely — the active assistant's
    // hosting is the only signal that matters.
    isLocalModeMock.mockImplementation(() => true);
    setLifecycle({ kind: "active", isLocal: false });
    useAuthStore.setState({ hasPlatformSession: true });
    useAssistantFeatureFlagStore.setState({ hasHydrated: false });
    const { result } = renderHook(() =>
      usePlatformGate({ platformHostedOnly: true }),
    );
    expect(result.current).toBe("full");
  });

  test('returns "full" during loading lifecycle state when logged in (no flicker to gated)', () => {
    // Before any server resolution lands, the lifecycle state is
    // `{ kind: "loading" }`. We can't yet know whether the assistant
    // is self-hosted, so we resolve on session only — matching the
    // "none resolved" rows of the truth table.
    setLifecycle({ kind: "loading" });
    useAuthStore.setState({ hasPlatformSession: true });
    const { result } = renderHook(() =>
      usePlatformGate({ platformHostedOnly: true }),
    );
    expect(result.current).toBe("full");
  });

  test('returns "disabled" during loading lifecycle state when NOT logged in', () => {
    setLifecycle({ kind: "loading" });
    useAuthStore.setState({ hasPlatformSession: false });
    const { result } = renderHook(() =>
      usePlatformGate({ platformHostedOnly: true }),
    );
    expect(result.current).toBe("disabled");
  });

  test('returns "full" for unrelated lifecycle kinds (initializing, retired, error, etc) when logged in', () => {
    // None of these signal "the active assistant is self-hosted",
    // so the gate falls through to the session-only decision. They
    // are short-lived transitional states; over-gating them would
    // cause spurious flicker.
    const kinds: AssistantState[] = [
      { kind: "initializing" },
      { kind: "cleaning_up" },
      { kind: "retired" },
      { kind: "platform_hosted" },
      { kind: "awaiting_version_selection" },
      { kind: "error", message: "boom" },
    ];
    useAuthStore.setState({ hasPlatformSession: true });
    for (const assistantState of kinds) {
      setLifecycle(assistantState);
      const { result, unmount } = renderHook(() =>
        usePlatformGate({ platformHostedOnly: true }),
      );
      expect(result.current).toBe("full");
      unmount();
    }
  });
});
