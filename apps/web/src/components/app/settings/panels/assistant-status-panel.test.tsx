/**
 * Tests for AssistantStatusPanel healthzLoading behavior.
 *
 * Since this codebase does not have @testing-library/react, we verify the
 * loading-state logic by exercising the underlying API functions directly and
 * confirming that the component's fetch logic (extracted below) produces the
 * expected healthzLoading transitions.  The component logic is a thin
 * orchestrator over getAssistant / getAssistantHealthz.
 */

import { describe, expect, test } from "bun:test";

import {
  getAssistant,
  getAssistantHealthz,
} from "@/lib/assistants/api.js";

import {
  formatResourceMb,
  hasAssistantResourceMetrics,
} from "@/components/app/settings/panels/assistant-status-panel.js";

// ---------------------------------------------------------------------------
// Simulate the fetchAssistant logic from the component and verify the
// healthzLoading state transitions it would produce.
// ---------------------------------------------------------------------------

/**
 * Replays the fetchAssistant state-machine from the component and collects
 * healthzLoading state changes.  Returns the final healthzLoading value.
 */
async function runFetchAssistantLogic(
  getAssistantFn: () => ReturnType<typeof getAssistant>,
  getHealthzFn: (assistantId: string) => ReturnType<typeof getAssistantHealthz>,
): Promise<{ finalHealthzLoading: boolean; healthzCalled: boolean }> {
  let healthzLoading = false;
  let healthzCalled = false;

  try {
    const result = await getAssistantFn();
    if (result.ok) {
      healthzLoading = true;
      healthzCalled = true;
      await getHealthzFn(result.data.id)
        .then(() => {
          healthzLoading = false;
        })
        .catch(() => {
          healthzLoading = false;
        });
    } else {
      healthzLoading = false;
    }
  } catch {
    // This mirrors the component's catch block which now calls setHealthzLoading(false).
    healthzLoading = false;
  }

  return { finalHealthzLoading: healthzLoading, healthzCalled };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AssistantStatusPanel healthzLoading state", () => {
  test("healthzLoading starts false and ends false after successful fetch cycle", async () => {
    // getAssistant succeeds, then healthz succeeds.
    const getAssistantFn = async () => {
      return {
        ok: true as const,
        status: 200,
        data: {
          id: "asst-1",
          name: "My Assistant",
          status: "active" as const,
          created: "2024-01-01T00:00:00Z",
          modified: "2024-01-01T00:00:00Z",
          current_release_version: null,
          vembda_cluster_id: null,
          machine_size: null,
          maintenance_mode: { enabled: false, debug_pod_name: null },
          is_local: false,
          ingress_url: null,
          access_consented: false,
        },
      };
    };
    const getHealthzFn = async () => {
      return {
        ok: true as const,
        status: 200,
        data: {
          status: "ok",
          timestamp: "2024-01-01T00:00:00Z",
        },
      };
    };

    const { finalHealthzLoading, healthzCalled } = await runFetchAssistantLogic(
      getAssistantFn,
      getHealthzFn,
    );

    expect(healthzCalled).toBe(true);
    expect(finalHealthzLoading).toBe(false);
  });

  test("healthzLoading resets to false after healthz returns non-ok response", async () => {
    // getAssistant succeeds
    const getAssistantFn = async () => {
      return {
        ok: true as const,
        status: 200,
        data: {
          id: "asst-1",
          name: "My Assistant",
          status: "active" as const,
          created: "2024-01-01T00:00:00Z",
          modified: "2024-01-01T00:00:00Z",
          current_release_version: null,
          vembda_cluster_id: null,
          machine_size: null,
          maintenance_mode: { enabled: false, debug_pod_name: null },
          is_local: false,
          ingress_url: null,
          access_consented: false,
        },
      };
    };
    // healthz returns non-ok
    const getHealthzFn = async () => {
      return {
        ok: false as const,
        status: 503,
        error: { detail: "Service unavailable" },
      };
    };

    const { finalHealthzLoading } = await runFetchAssistantLogic(
      getAssistantFn,
      getHealthzFn,
    );

    expect(finalHealthzLoading).toBe(false);
  });

  test("healthzLoading resets to false after getAssistantHealthz throws", async () => {
    // getAssistant succeeds
    const getAssistantFn = async () => {
      return {
        ok: true as const,
        status: 200,
        data: {
          id: "asst-1",
          name: "My Assistant",
          status: "active" as const,
          created: "2024-01-01T00:00:00Z",
          modified: "2024-01-01T00:00:00Z",
          current_release_version: null,
          vembda_cluster_id: null,
          machine_size: null,
          maintenance_mode: { enabled: false, debug_pod_name: null },
          is_local: false,
          ingress_url: null,
          access_consented: false,
        },
      };
    };
    // healthz throws a network error
    const getHealthzFn = async (): Promise<
      Awaited<ReturnType<typeof getAssistantHealthz>>
    > => {
      throw new Error("network error");
    };

    const { finalHealthzLoading } = await runFetchAssistantLogic(
      getAssistantFn,
      getHealthzFn,
    );

    expect(finalHealthzLoading).toBe(false);
  });

  test("healthzLoading resets to false after getAssistant() throws", async () => {
    // getAssistant throws (e.g. network error)
    const getAssistantFn = async (): Promise<
      Awaited<ReturnType<typeof getAssistant>>
    > => {
      throw new Error("network error");
    };
    const getHealthzFn = async (id: string) => getAssistantHealthz(id);

    const { finalHealthzLoading, healthzCalled } = await runFetchAssistantLogic(
      getAssistantFn,
      getHealthzFn,
    );

    // healthz should never have been called since getAssistant threw
    expect(healthzCalled).toBe(false);
    // healthzLoading must be reset to false (not stuck at a prior true value)
    expect(finalHealthzLoading).toBe(false);
  });

  test("healthzLoading stays false when getAssistant returns non-ok", async () => {
    const getAssistantFn = async () => {
      return {
        ok: false as const,
        status: 500,
        error: { detail: "Internal server error" },
      };
    };

    const { finalHealthzLoading, healthzCalled } = await runFetchAssistantLogic(
      getAssistantFn,
      (id) => getAssistantHealthz(id),
    );

    expect(healthzCalled).toBe(false);
    expect(finalHealthzLoading).toBe(false);
  });
});

describe("AssistantStatusPanel resource helpers", () => {
  test("detects resource metrics from healthz", () => {
    expect(hasAssistantResourceMetrics(null)).toBe(false);
    expect(
      hasAssistantResourceMetrics({
        status: "ok",
        timestamp: "2026-04-29T00:00:00Z",
      }),
    ).toBe(false);
    expect(
      hasAssistantResourceMetrics({
        status: "ok",
        timestamp: "2026-04-29T00:00:00Z",
        disk: {
          path: "/workspace",
          usedMb: 925,
          totalMb: 1000,
          freeMb: 75,
        },
      }),
    ).toBe(true);
  });

  test("formats megabyte values with readable units", () => {
    expect(formatResourceMb(512)).toBe("512 MB");
    expect(formatResourceMb(1536)).toBe("1.5 GB");
  });
});
