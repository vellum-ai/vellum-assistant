import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

const isLocalModeMock = mock(() => false);
const isPlatformDisabledMock = mock(() => false);
mock.module("@/lib/local-mode", () => ({
  isLocalMode: isLocalModeMock,
  isPlatformDisabled: isPlatformDisabledMock,
}));

import { useAuthStore } from "@/stores/auth-store";
import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import type { AssistantState } from "@/assistant/types";
import {
  useActiveAssistantIsPlatformHosted,
  useActiveAssistantLifecycleIsLoading,
  usePlatformGate,
} from "@/hooks/use-platform-gate";

const initialAuthState = useAuthStore.getState();
const initialLifecycleState = useAssistantLifecycleStore.getState();

function setLifecycle(assistantState: AssistantState) {
  useAssistantLifecycleStore.setState({ assistantState });
}

beforeEach(() => {
  isLocalModeMock.mockImplementation(() => false);
  isPlatformDisabledMock.mockImplementation(() => false);
  useAuthStore.setState(initialAuthState, true);
  useAssistantLifecycleStore.setState(initialLifecycleState, true);
});

afterEach(() => {
  cleanup();
});

describe("usePlatformGate — default (standard pattern)", () => {
  test('returns "full" when platform-hosted and logged in', () => {
    useAuthStore.setState({ platformSession: "present" });
    const { result } = renderHook(() => usePlatformGate());
    expect(result.current).toBe("full");
  });

  test('returns "disabled" when platform-hosted and not logged in', () => {
    useAuthStore.setState({ platformSession: "absent" });
    const { result } = renderHook(() => usePlatformGate());
    expect(result.current).toBe("disabled");
  });

  test('returns "full" in local mode when logged in and platform not disabled', () => {
    isLocalModeMock.mockImplementation(() => true);
    useAuthStore.setState({ platformSession: "present" });
    isPlatformDisabledMock.mockImplementation(() => false);
    const { result } = renderHook(() => usePlatformGate());
    expect(result.current).toBe("full");
  });

  test('returns "gated" in local mode when VELLUM_DISABLE_PLATFORM is set', () => {
    isLocalModeMock.mockImplementation(() => true);
    useAuthStore.setState({ platformSession: "present" });
    isPlatformDisabledMock.mockImplementation(() => true);
    const { result } = renderHook(() => usePlatformGate());
    expect(result.current).toBe("gated");
  });
});

describe("usePlatformGate — five documented user states (CONVENTIONS.md)", () => {
  // Locks the default-branch outcome usePlatformGate returns for each of the
  // five user states the platform gating contract documents (CONVENTIONS.md).

  test('1. platform-hosted + logged in → "full"', () => {
    isLocalModeMock.mockImplementation(() => false);
    isPlatformDisabledMock.mockImplementation(() => false);
    useAuthStore.setState({ platformSession: "present" });
    const { result } = renderHook(() => usePlatformGate());
    expect(result.current).toBe("full");
  });

  test('2. platform-hosted + NOT logged in → "disabled"', () => {
    isLocalModeMock.mockImplementation(() => false);
    isPlatformDisabledMock.mockImplementation(() => false);
    useAuthStore.setState({ platformSession: "absent" });
    const { result } = renderHook(() => usePlatformGate());
    expect(result.current).toBe("disabled");
  });

  test('3. self-hosted + platform ON + logged in → "full"', () => {
    isLocalModeMock.mockImplementation(() => true);
    isPlatformDisabledMock.mockImplementation(() => false);
    useAuthStore.setState({ platformSession: "present" });
    const { result } = renderHook(() => usePlatformGate());
    expect(result.current).toBe("full");
  });

  test('4. self-hosted + platform ON + NOT logged in → "disabled"', () => {
    isLocalModeMock.mockImplementation(() => true);
    isPlatformDisabledMock.mockImplementation(() => false);
    useAuthStore.setState({ platformSession: "absent" });
    const { result } = renderHook(() => usePlatformGate());
    expect(result.current).toBe("disabled");
  });

  test('5. self-hosted + platform OFF (VELLUM_DISABLE_PLATFORM) → "gated"', () => {
    isLocalModeMock.mockImplementation(() => true);
    isPlatformDisabledMock.mockImplementation(() => true);
    // Session value is irrelevant once platform features are off; assert both.
    for (const platformSession of ["present", "absent"] as const) {
      useAuthStore.setState({ platformSession });
      const { result, unmount } = renderHook(() => usePlatformGate());
      expect(result.current).toBe("gated");
      unmount();
    }
  });

  test('pre-settle "unknown" session gates the surface as "disabled"', () => {
    // The optimistic tri-state: "unknown" is not a live session, so the
    // default branch treats it like "absent" until the probe settles.
    isLocalModeMock.mockImplementation(() => false);
    isPlatformDisabledMock.mockImplementation(() => false);
    useAuthStore.setState({ platformSession: "unknown" });
    const { result } = renderHook(() => usePlatformGate());
    expect(result.current).toBe("disabled");
  });
});

describe("usePlatformGate — { platformHostedOnly: true }", () => {
  test('returns "full" when lifecycle resolves to active+platform-hosted and logged in', () => {
    setLifecycle({ kind: "active", isLocal: false });
    useAuthStore.setState({ platformSession: "present" });
    const { result } = renderHook(() =>
      usePlatformGate({ platformHostedOnly: true }),
    );
    expect(result.current).toBe("full");
  });

  test('returns "disabled" when lifecycle resolves to active+platform-hosted and NOT logged in', () => {
    setLifecycle({ kind: "active", isLocal: false });
    useAuthStore.setState({ platformSession: "absent" });
    const { result } = renderHook(() =>
      usePlatformGate({ platformHostedOnly: true }),
    );
    expect(result.current).toBe("disabled");
  });

  test('returns "gated" when lifecycle resolves to self_hosted (any app mode)', () => {
    // The "platform mode + self-hosted assistant" case: API returns
    // is_local: true, lifecycle projects { kind: "self_hosted" }.
    setLifecycle({ kind: "self_hosted" });
    useAuthStore.setState({ platformSession: "present" });
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
    useAuthStore.setState({ platformSession: "present" });
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
    useAuthStore.setState({ platformSession: "present" });
    const { result } = renderHook(() =>
      usePlatformGate({ platformHostedOnly: true }),
    );
    expect(result.current).toBe("full");
  });

  test('ignores VELLUM_DISABLE_PLATFORM when active assistant is platform-hosted', () => {
    // The env var gates the daemon-side API interceptor in local mode —
    // it has no bearing on UI that targets a platform-hosted assistant.
    isLocalModeMock.mockImplementation(() => true);
    setLifecycle({ kind: "active", isLocal: false });
    useAuthStore.setState({ platformSession: "present" });
    isPlatformDisabledMock.mockImplementation(() => true);
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
    useAuthStore.setState({ platformSession: "present" });
    const { result } = renderHook(() =>
      usePlatformGate({ platformHostedOnly: true }),
    );
    expect(result.current).toBe("full");
  });

  test('returns "disabled" during loading lifecycle state when NOT logged in', () => {
    setLifecycle({ kind: "loading" });
    useAuthStore.setState({ platformSession: "absent" });
    const { result } = renderHook(() =>
      usePlatformGate({ platformHostedOnly: true }),
    );
    expect(result.current).toBe("disabled");
  });

  test('returns "full" for unrelated lifecycle kinds (initializing, error, etc) when logged in', () => {
    // None of these signal "the active assistant is self-hosted",
    // so the gate falls through to the session-only decision. They
    // are short-lived transitional states; over-gating them would
    // cause spurious flicker.
    const kinds: AssistantState[] = [
      { kind: "initializing" },
      { kind: "cleaning_up" },
      { kind: "error", message: "boom" },
    ];
    useAuthStore.setState({ platformSession: "present" });
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

describe("useActiveAssistantIsPlatformHosted", () => {
  test("returns true for kind: active with isLocal: false", () => {
    setLifecycle({ kind: "active", isLocal: false });
    const { result } = renderHook(() => useActiveAssistantIsPlatformHosted());
    expect(result.current).toBe(true);
  });

  test("returns false during the loading window (no positive resolution yet)", () => {
    // This is the critical race the helper exists to handle: settings
    // routes are not under <ActiveAssistantGate>, so a fresh deep-link
    // renders while lifecycle is still { kind: "loading" }. The gate
    // returns "full" intentionally (to avoid UI flicker on chrome),
    // but network fetches must wait for resolution.
    setLifecycle({ kind: "loading" });
    const { result } = renderHook(() => useActiveAssistantIsPlatformHosted());
    expect(result.current).toBe(false);
  });

  test("returns false for kind: self_hosted", () => {
    setLifecycle({ kind: "self_hosted" });
    const { result } = renderHook(() => useActiveAssistantIsPlatformHosted());
    expect(result.current).toBe(false);
  });

  test("returns false for kind: active with isLocal: true (gateway-auth short-circuit)", () => {
    setLifecycle({ kind: "active", isLocal: true });
    const { result } = renderHook(() => useActiveAssistantIsPlatformHosted());
    expect(result.current).toBe(false);
  });

  test("returns false for transitional and non-hosted-resolved kinds", () => {
    const kinds: AssistantState[] = [
      { kind: "initializing" },
      { kind: "cleaning_up" },
      { kind: "error", message: "boom" },
    ];
    for (const assistantState of kinds) {
      setLifecycle(assistantState);
      const { result, unmount } = renderHook(() =>
        useActiveAssistantIsPlatformHosted(),
      );
      expect(result.current).toBe(false);
      unmount();
    }
  });
});

describe("useActiveAssistantLifecycleIsLoading", () => {
  test("returns true for kind: loading", () => {
    setLifecycle({ kind: "loading" });
    const { result } = renderHook(() =>
      useActiveAssistantLifecycleIsLoading(),
    );
    expect(result.current).toBe(true);
  });

  test("returns false for kind: self_hosted (resolved)", () => {
    setLifecycle({ kind: "self_hosted" });
    const { result } = renderHook(() =>
      useActiveAssistantLifecycleIsLoading(),
    );
    expect(result.current).toBe(false);
  });

  test("returns false for kind: active (resolved)", () => {
    setLifecycle({ kind: "active", isLocal: false });
    const { result } = renderHook(() =>
      useActiveAssistantLifecycleIsLoading(),
    );
    expect(result.current).toBe(false);
  });

  test("returns false for already-resolved non-hosted kinds", () => {
    // This is the trap the helper exists to avoid: these states are
    // *decided non-hosted*, not *still resolving*. UI that uses
    // `!isPlatformHosted` as the race-window signal would treat them as
    // resolving forever and stick on a spinner / disabled button.
    setLifecycle({ kind: "error", message: "boom" });
    const { result } = renderHook(() =>
      useActiveAssistantLifecycleIsLoading(),
    );
    expect(result.current).toBe(false);
  });

  test("returns true for transitional kinds (initializing, cleaning_up)", () => {
    // `initializing` / `cleaning_up` are transitional states during setup
    // and teardown. The hosting outcome (active vs error/retired) is not yet
    // determined. Treat as resolving until terminal.
    const kinds: AssistantState[] = [
      { kind: "initializing" },
      { kind: "cleaning_up" },
    ];
    for (const assistantState of kinds) {
      setLifecycle(assistantState);
      const { result, unmount } = renderHook(() =>
        useActiveAssistantLifecycleIsLoading(),
      );
      expect(result.current).toBe(true);
      unmount();
    }
  });
});
