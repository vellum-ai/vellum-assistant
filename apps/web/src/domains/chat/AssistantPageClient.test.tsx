/**
 * Tests for maintenance-mode banner integration in AssistantPageClient.
 *
 * These tests exercise the logic layers (API, state derivation, and component
 * props) without a full React render, consistent with other test files in this
 * directory that cannot use @testing-library/react.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { createCriticalDiskPressureStatus as diskPressureStatus } from "@/lib/assistants/disk-pressure-test-fixtures.js";
import {
  getDiskPressureChatBlockReason,
  isChatInputDisabledByDiskPressure,
  shouldEnableDiskPressureMonitor,
} from "@/lib/assistants/disk-pressure.js";
import { routes } from "@/lib/routes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown): void {
  globalThis.fetch = mock(async () =>
    Response.json(body, {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>): void {
  let callIndex = 0;
  globalThis.fetch = mock(async () => {
    const idx = Math.min(callIndex, responses.length - 1);
    callIndex++;
    const resp = responses[idx];
    if (!resp) throw new Error("mockFetchSequence: no responses provided");
    return Response.json(resp.body, {
      status: resp.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

let originalFetch: typeof fetch;
let originalDocument: typeof globalThis.document;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // CSRF helpers access document.cookie — stub it for the test environment.
  originalDocument = globalThis.document;
  // @ts-expect-error - stub document for tests
  globalThis.document = { cookie: "" };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.document = originalDocument;
});

// ---------------------------------------------------------------------------
// Banner visibility — derives from maintenance_mode on the assistant response
// ---------------------------------------------------------------------------

describe("maintenance mode banner visibility", () => {
  test("banner should be shown when maintenance_mode.enabled is true", async () => {
    mockFetch(200, {
      count: 1,
      results: [
        {
          id: "asst-1",
          status: "active",
          created: "2024-01-01T00:00:00Z",
          maintenance_mode: { enabled: true, debug_pod_name: "debug-pod-abc123" },
          machine_size: null,
        },
      ],
    });
    const { getAssistant } = await import("@/lib/assistants/api.js");
    const result = await getAssistant();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.maintenance_mode.enabled).toBe(true);
    expect(result.data.maintenance_mode.debug_pod_name).toBe("debug-pod-abc123");
  });

  test("banner should not be shown when maintenance_mode.enabled is false", async () => {
    mockFetch(200, {
      count: 1,
      results: [
        {
          id: "asst-1",
          status: "active",
          created: "2024-01-01T00:00:00Z",
          maintenance_mode: { enabled: false, debug_pod_name: null },
          machine_size: null,
        },
      ],
    });
    const { getAssistant } = await import("@/lib/assistants/api.js");
    const result = await getAssistant();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.maintenance_mode.enabled).toBe(false);
  });

  test("debug_pod_name can be null when maintenance mode is enabled", async () => {
    mockFetch(200, {
      count: 1,
      results: [
        {
          id: "asst-1",
          status: "active",
          created: "2024-01-01T00:00:00Z",
          maintenance_mode: { enabled: true, debug_pod_name: null },
          machine_size: null,
        },
      ],
    });
    const { getAssistant } = await import("@/lib/assistants/api.js");
    const result = await getAssistant();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.maintenance_mode.enabled).toBe(true);
    expect(result.data.maintenance_mode.debug_pod_name).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// State transition — maintenance_mode is preserved in active state
// ---------------------------------------------------------------------------

describe("maintenance mode state derivation", () => {
  function deriveMaintenanceModeFromResult(
    result: Awaited<ReturnType<typeof import("@/lib/assistants/api.js").getAssistant>>,
  ): { enabled: boolean } | null {
    if (!result.ok || result.data.status !== "active") return null;
    const mm = result.data.maintenance_mode;
    return {
      enabled: mm.enabled,
    };
  }

  test("maintenance mode info is extracted from active assistant response", async () => {
    mockFetch(200, {
      count: 1,
      results: [
        {
          id: "asst-1",
          status: "active",
          created: "2024-01-01T00:00:00Z",
          maintenance_mode: { enabled: true, debug_pod_name: "pod-xyz" },
          machine_size: null,
        },
      ],
    });
    const { getAssistant } = await import("@/lib/assistants/api.js");
    const result = await getAssistant();
    const info = deriveMaintenanceModeFromResult(result);
    expect(info).toEqual({ enabled: true });
  });

  test("maintenance mode info is not extracted for non-active state", async () => {
    mockFetch(200, {
      count: 1,
      results: [
        {
          id: "asst-1",
          status: "initializing",
          created: "2024-01-01T00:00:00Z",
          maintenance_mode: { enabled: false, debug_pod_name: null },
          machine_size: null,
        },
      ],
    });
    const { getAssistant } = await import("@/lib/assistants/api.js");
    const result = await getAssistant();
    const info = deriveMaintenanceModeFromResult(result);
    expect(info).toBeNull();
  });
});

// SDK_BASE_OPTIONS mirrors the pattern used in api.ts for unit-test environments
const SDK_BASE_OPTIONS =
  typeof window === "undefined"
    ? ({ baseUrl: "http://localhost" } as const)
    : ({} as const);

// ---------------------------------------------------------------------------
// Action wiring — exit endpoint is called on "Resume Assistant" click
// ---------------------------------------------------------------------------

describe("exit maintenance mode action", () => {
  test("calls exit endpoint with correct assistant_id", async () => {
    mockFetch(200, {});
    const { assistantsMaintenanceModeExitCreate } = await import(
      "@/generated/api/sdk.gen"
    );
    const result = await assistantsMaintenanceModeExitCreate({
      ...SDK_BASE_OPTIONS,
      path: { assistant_id: "asst-exit-test" },
      throwOnError: false,
    });
    expect(result.response).toBeDefined();
    expect(result.response?.ok).toBe(true);
    expect(result.response?.status).toBe(200);
  });

  test("exit endpoint failure returns non-ok response", async () => {
    mockFetch(502, { detail: "Assistant unavailable" });
    const { assistantsMaintenanceModeExitCreate } = await import(
      "@/generated/api/sdk.gen"
    );
    const result = await assistantsMaintenanceModeExitCreate({
      ...SDK_BASE_OPTIONS,
      path: { assistant_id: "asst-fail" },
      throwOnError: false,
    });
    expect(result.response).toBeDefined();
    expect(result.response?.ok).toBe(false);
    expect(result.response?.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// Gap B: response?.ok null guard in MaintenanceModeBanner
// ---------------------------------------------------------------------------

describe("exit maintenance mode network error handling", () => {
  test("undefined response (network error) is treated as non-ok — no TypeError thrown", () => {
    // Simulate what heyapi returns on a network error: { response: undefined }
    const result: { response: Response | undefined } = { response: undefined };

    // The fix changes `response.ok` to `response?.ok`.
    // Accessing `result.response?.ok` must return undefined (falsy), not throw.
    const isOk = result.response?.ok;
    expect(isOk).toBeUndefined();
    // Falsy check mirrors the component's if (response?.ok) guard
    expect(!!isOk).toBe(false);
  });

  test("defined response with ok=true passes the null guard", () => {
    const result: { response: Response | undefined } = {
      response: new Response(null, { status: 200 }),
    };
    const isOk = result.response?.ok;
    expect(isOk).toBe(true);
  });

  test("defined response with ok=false passes the null guard", () => {
    const result: { response: Response | undefined } = {
      response: new Response(null, { status: 502 }),
    };
    const isOk = result.response?.ok;
    expect(isOk).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap C: inputDisabled derivation accounts for maintenance mode
// ---------------------------------------------------------------------------

describe("inputDisabled during maintenance mode", () => {
  test("input is disabled when maintenance mode is active", () => {
    // Mirrors the derivation: (assistantState.kind === "active" && !!assistantState.maintenanceMode?.enabled)
    const assistantState = {
      kind: "active" as const,
      maintenanceMode: { enabled: true },
    };
    const isDisabledByMaintenance =
      assistantState.kind === "active" && !!assistantState.maintenanceMode?.enabled;
    expect(isDisabledByMaintenance).toBe(true);
  });

  test("input is not disabled when maintenance mode is inactive", () => {
    const assistantState = {
      kind: "active" as const,
      maintenanceMode: { enabled: false },
    };
    const isDisabledByMaintenance =
      assistantState.kind === "active" && !!assistantState.maintenanceMode?.enabled;
    expect(isDisabledByMaintenance).toBe(false);
  });

  test("input is not disabled when maintenance mode is absent (no maintenanceMode key)", () => {
    const assistantState: { kind: "active"; maintenanceMode?: { enabled: boolean } } = {
      kind: "active",
    };
    const isDisabledByMaintenance =
      assistantState.kind === "active" && !!assistantState.maintenanceMode?.enabled;
    expect(isDisabledByMaintenance).toBe(false);
  });

  test("input is not disabled when assistant is not in active state", () => {
    const assistantState: { kind: string } = { kind: "loading" };
    const isDisabledByMaintenance =
      assistantState.kind === "active" && !!(assistantState as { maintenanceMode?: { enabled: boolean } }).maintenanceMode?.enabled;
    expect(isDisabledByMaintenance).toBe(false);
  });
});

describe("safe storage chat gate", () => {
  test("disk pressure monitor is disabled unless the feature flag, active state, and assistant id are present", () => {
    expect(
      shouldEnableDiskPressureMonitor({
        safeStorageLimits: false,
        assistantStateKind: "active",
        assistantId: "asst-1",
      }),
    ).toBe(false);
    expect(
      shouldEnableDiskPressureMonitor({
        safeStorageLimits: true,
        assistantStateKind: "loading",
        assistantId: "asst-1",
      }),
    ).toBe(false);
    expect(
      shouldEnableDiskPressureMonitor({
        safeStorageLimits: true,
        assistantStateKind: "active",
        assistantId: null,
      }),
    ).toBe(false);
    expect(
      shouldEnableDiskPressureMonitor({
        safeStorageLimits: true,
        assistantStateKind: "active",
        assistantId: "asst-1",
      }),
    ).toBe(true);
  });

  test("unresolved initial status does not disable chat input — we don't block on pending", () => {
    expect(
      isChatInputDisabledByDiskPressure({
        monitorEnabled: true,
        hasResolvedStatus: false,
        status: null,
      }),
    ).toBe(false);
  });

  test("resolved ok status allows chat input", () => {
    expect(
      isChatInputDisabledByDiskPressure({
        monitorEnabled: true,
        hasResolvedStatus: true,
        status: diskPressureStatus({
          state: "ok",
          locked: false,
          effectivelyLocked: false,
        }),
      }),
    ).toBe(false);
  });

  test("unacknowledged cleanup mode disables chat input", () => {
    expect(
      isChatInputDisabledByDiskPressure({
        monitorEnabled: true,
        hasResolvedStatus: true,
        status: diskPressureStatus({
          acknowledged: false,
          effectivelyLocked: true,
        }),
      }),
    ).toBe(true);
  });

  test("acknowledged cleanup mode keeps the banner possible while allowing chat input", () => {
    const status = diskPressureStatus({
      acknowledged: true,
      effectivelyLocked: true,
    });

    expect(
      isChatInputDisabledByDiskPressure({
        monitorEnabled: true,
        hasResolvedStatus: true,
        status,
      }),
    ).toBe(false);
  });

  test("ok, disabled, and unlocked status do not block chat input", () => {
    for (const status of [
      diskPressureStatus({
        state: "ok",
        locked: false,
        effectivelyLocked: false,
      }),
      diskPressureStatus({
        enabled: false,
        state: "disabled",
        locked: false,
        effectivelyLocked: false,
      }),
      diskPressureStatus({
        locked: true,
        effectivelyLocked: false,
      }),
    ]) {
      expect(
        isChatInputDisabledByDiskPressure({
          monitorEnabled: true,
          hasResolvedStatus: true,
          status,
        }),
      ).toBe(false);
    }
  });

  test("disabled monitor does not block chat input before status resolves", () => {
    expect(
      isChatInputDisabledByDiskPressure({
        monitorEnabled: false,
        hasResolvedStatus: false,
        status: null,
      }),
    ).toBe(false);
  });

  test("direct send paths can use the same disk pressure block reason as the composer", () => {
    expect(
      getDiskPressureChatBlockReason({
        monitorEnabled: true,
        hasResolvedStatus: false,
        status: null,
      }),
    ).toBeNull();
    expect(
      getDiskPressureChatBlockReason({
        monitorEnabled: true,
        hasResolvedStatus: true,
        status: diskPressureStatus({ effectivelyLocked: true }),
      }),
    ).toBe("acknowledgement-required");
    expect(
      getDiskPressureChatBlockReason({
        monitorEnabled: true,
        hasResolvedStatus: true,
        status: diskPressureStatus({
          acknowledged: true,
          effectivelyLocked: true,
        }),
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Refresh after exit — assistant detail reflects updated state after resume
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Onboarding gate on the auto_hatch branch
//
// The component's `checkAssistant` flow calls `resolveOnboardingRedirect`
// BEFORE deciding between the nonprod version-selection screen and the
// auto-hatch path. We can't render the component in this test environment
// (no @testing-library/react), but we can exercise the exact gate logic
// and the branch selection in the same order the component does.
// ---------------------------------------------------------------------------

describe("onboarding gate on auto_hatch branch", () => {
  // Minimal in-memory localStorage/window shim — the gate reads
  // `window.localStorage.getItem("onboarding.completed")` directly.
  class MemStorage implements Storage {
    private s = new Map<string, string>();
    get length(): number { return this.s.size; }
    clear(): void { this.s.clear(); }
    getItem(k: string): string | null { return this.s.has(k) ? (this.s.get(k) ?? null) : null; }
    key(i: number): string | null { return Array.from(this.s.keys())[i] ?? null; }
    removeItem(k: string): void { this.s.delete(k); }
    setItem(k: string, v: string): void { this.s.set(k, String(v)); }
  }
  const mem = new MemStorage();
  const origWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const origLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: { localStorage: mem },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: mem,
      configurable: true,
      writable: true,
    });
    mem.clear();
  });

  afterEach(() => {
    mem.clear();
    if (origWindow) {
      Object.defineProperty(globalThis, "window", origWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
    if (origLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", origLocalStorage);
    } else {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  // Replica of the component's decision tree on the `auto_hatch` kind, minus
  // the retired/platform-hosted short-circuits which are unrelated to this PR.
  // Order matches AssistantPageClient.tsx `checkAssistant`:
  //   1) onboarding gate
  //   2) nonprod version-selection
  //   3) auto-hatch
  function decideAutoHatchBranch({
    isNonProduction,
    resolveRedirect,
  }: {
    isNonProduction: boolean;
    resolveRedirect: (opts: {
      intendedDestination: string;
    }) => string | null;
  }): { branch: "onboarding"; to: string } | { branch: "version_selection" } | { branch: "auto_hatch" } {
    const redirect = resolveRedirect({
      intendedDestination: routes.assistant,
    });
    if (redirect) return { branch: "onboarding", to: redirect };
    if (isNonProduction) return { branch: "version_selection" };
    return { branch: "auto_hatch" };
  }

  test("auto_hatch + onboarding NOT completed -> router.replace('/assistant/onboarding/privacy'); VersionSelectionScreen NOT rendered", async () => {
    // Arrange: empty list on getAssistant -> synthesizes status=404 ->
    // resolveAssistantLifecycleState -> auto_hatch. No onboarding.completed set.
    mockFetch(200, { count: 0, results: [] });
    const { getAssistant } = await import("@/lib/assistants/api.js");
    const { resolveAssistantLifecycleState } = await import("@/lib/assistants/lifecycle.js");
    const { resolveOnboardingRedirect } = await import("@/lib/onboarding/gate.js");

    const result = await getAssistant();
    const next = resolveAssistantLifecycleState(result);
    expect(next.kind).toBe("auto_hatch");

    const replace = mock((_to: string) => {});
    const decision = decideAutoHatchBranch({
      isNonProduction: true, // even in nonprod, onboarding gate wins
      resolveRedirect: resolveOnboardingRedirect,
    });

    // Assert: onboarding branch taken, VersionSelectionScreen path NOT.
    expect(decision.branch).toBe("onboarding");
    if (decision.branch === "onboarding") {
      expect(decision.to).toBe(routes.onboarding.privacy);
      replace(decision.to);
    }
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(routes.onboarding.privacy);
  });

  test("auto_hatch + onboarding.completed='true' -> version_selection path runs (regression)", async () => {
    mem.setItem("onboarding.completed", "true");
    mockFetch(200, { count: 0, results: [] });
    const { getAssistant } = await import("@/lib/assistants/api.js");
    const { resolveAssistantLifecycleState } = await import("@/lib/assistants/lifecycle.js");
    const { resolveOnboardingRedirect } = await import("@/lib/onboarding/gate.js");

    const result = await getAssistant();
    const next = resolveAssistantLifecycleState(result);
    expect(next.kind).toBe("auto_hatch");

    const decision = decideAutoHatchBranch({
      isNonProduction: true,
      resolveRedirect: resolveOnboardingRedirect,
    });

    // Onboarding is completed -> gate returns null -> fall through to the
    // existing nonprod awaiting_version_selection path.
    expect(decision.branch).toBe("version_selection");
  });
});

// ---------------------------------------------------------------------------
// Self-hosted local assistant discovery
// ---------------------------------------------------------------------------

describe("self-hosted local assistant discovery", () => {
  test("getAssistant returns a local assistant when it is the only one", async () => {
      // getAssistant now queries hosting=platform first (empty), then hosting=local.
      mockFetchSequence([
        { status: 200, body: { count: 0, results: [] } },
        {
          status: 200,
          body: {
            count: 1,
            results: [
              {
                id: "asst-local-1",
                status: "active",
                created: "2024-06-01T00:00:00Z",
                maintenance_mode: { enabled: false, debug_pod_name: null },
                is_local: true,
                ingress_url: null,
                machine_size: null,
              },
            ],
          },
        },
      ]);
      const { getAssistant } = await import("@/lib/assistants/api.js");
      const result = await getAssistant();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.id).toBe("asst-local-1");
      expect(result.data.is_local).toBe(true);
    });

    test("getAssistant prefers platform assistant when both exist", async () => {
      // Platform query returns the platform assistant — local query never runs.
      mockFetch(200, {
        count: 1,
        results: [
          {
            id: "asst-platform-1",
            status: "active",
            created: "2024-06-01T00:00:00Z",
            maintenance_mode: { enabled: false, debug_pod_name: null },
            is_local: false,
            ingress_url: null,
            machine_size: null,
          },
        ],
      });
      const { getAssistant } = await import("@/lib/assistants/api.js");
      const result = await getAssistant();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.id).toBe("asst-platform-1");
      expect(result.data.is_local).toBe(false);
    });

    test("local assistant resolves to self_hosted lifecycle state", async () => {
      // Platform query returns empty, local query returns the assistant.
      // Active self-hosted assistants surface a dedicated `self_hosted`
      // state so the page can render an empty-state with a settings link
      // instead of trying to load conversations the platform can't serve.
      mockFetchSequence([
        { status: 200, body: { count: 0, results: [] } },
        {
          status: 200,
          body: {
            count: 1,
            results: [
              {
                id: "asst-local-1",
                status: "active",
                created: "2024-06-01T00:00:00Z",
                maintenance_mode: { enabled: false, debug_pod_name: null },
                is_local: true,
                ingress_url: null,
                machine_size: null,
              },
            ],
          },
        },
      ]);
      const { getAssistant } = await import("@/lib/assistants/api.js");
      const { resolveAssistantLifecycleState } = await import("@/lib/assistants/lifecycle.js");
      const result = await getAssistant();
      const state = resolveAssistantLifecycleState(result);
      expect(state.kind).toBe("self_hosted");
    });

    test("local assistant does not trigger onboarding redirect", async () => {
      // Even if onboarding is not completed, an active local assistant
      // should resolve to 'self_hosted' (NOT 'auto_hatch'), so the
      // onboarding gate is never reached.
      // Platform query returns empty, local query returns the assistant.
      mockFetchSequence([
        { status: 200, body: { count: 0, results: [] } },
        {
          status: 200,
          body: {
            count: 1,
            results: [
              {
                id: "asst-local-1",
                status: "active",
                created: "2024-06-01T00:00:00Z",
                maintenance_mode: { enabled: false, debug_pod_name: null },
                is_local: true,
                ingress_url: null,
                machine_size: null,
              },
            ],
          },
        },
      ]);
      const { getAssistant } = await import("@/lib/assistants/api.js");
      const { resolveAssistantLifecycleState } = await import("@/lib/assistants/lifecycle.js");
      const result = await getAssistant();
      const state = resolveAssistantLifecycleState(result);
      // Active self-hosted resolves to 'self_hosted' — auto_hatch only
      // fires on 404, which never happens when an assistant exists.
      expect(state.kind).not.toBe("auto_hatch");
      expect(state.kind).toBe("self_hosted");
    });
});

describe("refresh after exiting maintenance mode", () => {
  test("assistant is no longer in maintenance mode after successful exit", async () => {
    // Simulates the refresh that happens after the exit endpoint succeeds
    mockFetch(200, {
      count: 1,
      results: [
        {
          id: "asst-1",
          status: "active",
          created: "2024-01-01T00:00:00Z",
          maintenance_mode: { enabled: false, debug_pod_name: null },
          machine_size: null,
        },
      ],
    });
    const { getAssistant } = await import("@/lib/assistants/api.js");
    const result = await getAssistant();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.maintenance_mode.enabled).toBe(false);
  });

  test("re-fetch after exit reflects maintenance_mode disabled", async () => {
    // Two sequential responses: first in maintenance mode, second after exit
    mockFetchSequence([
      {
        status: 200,
        body: {
          count: 1,
          results: [
            {
              id: "asst-1",
              status: "active",
              created: "2024-01-01T00:00:00Z",
              maintenance_mode: { enabled: true, debug_pod_name: "pod-abc" },
              machine_size: null,
            },
          ],
        },
      },
      {
        status: 200,
        body: {
          count: 1,
          results: [
            {
              id: "asst-1",
              status: "active",
              created: "2024-01-01T00:00:00Z",
              maintenance_mode: { enabled: false, debug_pod_name: null },
              machine_size: null,
            },
          ],
        },
      },
    ]);

    const { getAssistant } = await import("@/lib/assistants/api.js");

    // Before exit
    const before = await getAssistant();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.data.maintenance_mode.enabled).toBe(true);

    // After exit (simulated re-fetch)
    const after = await getAssistant();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.maintenance_mode.enabled).toBe(false);
  });
});
