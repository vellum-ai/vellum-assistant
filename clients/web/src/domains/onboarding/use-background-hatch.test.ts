/**
 * Unit tests for `useBackgroundHatch` — the research-onboarding flow's
 * background-hatch primitive. It must hatch at most once per instance
 * (ref-guarded), flip `ready` only after a health check passes, and resolve
 * `awaitReady()` with the assistant id (or reject on terminal failure).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";

import type {
  GetAssistantResult,
  GetHealthzResult,
  HatchResult,
} from "@/assistant/api";
import type { PurchasedProvisioningOutcome } from "@/domains/onboarding/purchased-provisioning";
import type { OrgHeaderReadiness } from "@/hooks/use-is-org-ready";

let hatchResult: HatchResult = {
  ok: true,
  status: 201,
  data: { id: "ast-research" } as never,
};
let getAssistantResult: GetAssistantResult = {
  ok: true,
  status: 200,
  data: { id: "ast-research", status: "active", is_local: false } as never,
};
let healthzResult: GetHealthzResult = {
  ok: true,
  status: 200,
  data: {} as never,
};

// Local-gateway routing state. A managed hatch drops both before it POSTs so
// discovery, healthz and the onboarding writes address the platform.
const clearGatewayTokenMock = mock(() => {});
const setSelfHostedConnectionMock = mock((_connection: unknown) => {});
mock.module("@/lib/auth/gateway-session", () => ({
  clearGatewayToken: clearGatewayTokenMock,
}));
mock.module("@/lib/self-hosted/connection", () => ({
  setSelfHostedConnection: setSelfHostedConnectionMock,
}));
// Clear counts sampled when the hatch POST fires, so ordering is asserted
// rather than mere occurrence.
let clearsAtHatch = { gateway: 0, selfHosted: 0 };

const hatchAssistantMock = mock(async (): Promise<HatchResult> => {
  clearsAtHatch = {
    gateway: clearGatewayTokenMock.mock.calls.length,
    selfHosted: setSelfHostedConnectionMock.mock.calls.length,
  };
  return hatchResult;
});
const getAssistantMock = mock(
  async (_id?: string): Promise<GetAssistantResult> => getAssistantResult,
);
const getAssistantHealthzMock = mock(
  async (_id: string): Promise<GetHealthzResult> => healthzResult,
);

mock.module("@/assistant/api", () => ({
  hatchAssistant: hatchAssistantMock,
  getAssistant: getAssistantMock,
  getAssistantHealthz: getAssistantHealthzMock,
}));
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
}));
const probeLocalGatewayReadyMock = mock(async (): Promise<boolean> => true);
// The lockfile registry the adopt fast-path resolves against. Tests seed it
// with the entries their scenario expects; ids not present fall through to
// list-based discovery.
let lockfileEntries: Record<string, { assistantId: string }> = {};
const getLockfileAssistantMock = mock(
  (id: string): { assistantId: string } | undefined => lockfileEntries[id],
);
// The desktop (Electron) build reports local mode even for a managed hatch.
let localMode = false;
const saveLockfileAssistantMock = mock(
  async (_entry: unknown): Promise<void> => undefined,
);
mock.module("@/lib/local-mode", () => ({
  probeLocalGatewayReady: probeLocalGatewayReadyMock,
  getLockfileAssistant: getLockfileAssistantMock,
  isLocalClient: () => localMode,
  // Surfaces the written entry to the assertions below; payload pinned by
  // `local-mode.test.ts`.
  saveManagedLockfileAssistant: async (
    assistantId: string,
    name: string | undefined,
    organizationId: string | undefined,
  ): Promise<void> => {
    await saveLockfileAssistantMock({
      assistantId,
      name,
      cloud: "vellum",
      runtimeUrl: "https://runtime.example",
      hatchedAt: new Date().toISOString(),
      organizationId,
    });
  },
}));
const fetchOrganizationsMock = mock(async (): Promise<void> => undefined);
mock.module("@/stores/organization-store", () => ({
  getActiveOrganizationIdForRequests: () => "org-1",
  useOrganizationStore: {
    getState: () => ({ fetchOrganizations: fetchOrganizationsMock }),
  },
}));
// Whether the `Vellum-Organization-Id` source can answer yet. The managed hatch
// holds its platform sequence on this; a warm store (the default) is ready on
// the first synchronous check and adds no delay.
let orgReadiness: OrgHeaderReadiness = "ready";
mock.module("@/hooks/use-is-org-ready", () => ({
  getOrgHeaderReadiness: () => orgReadiness,
  // Short ceiling so the never-settles case doesn't hold the suite open, while
  // still leaving room for a few of the hook's 100ms poll ticks.
  ORG_HEADER_SETTLE_TIMEOUT_MS: 500,
}));
mock.module("@/utils/api-errors", () => ({
  extractErrorMessage: (e: unknown, _r: unknown, fallback?: string) =>
    e &&
    typeof e === "object" &&
    typeof (e as { detail?: unknown }).detail === "string"
      ? (e as { detail: string }).detail
      : (fallback ?? "error"),
}));
mock.module("@sentry/react", () => ({
  captureMessage: () => {},
}));

// The paid stage only: the free path must never reach this module at all.
let provisioningOutcome: PurchasedProvisioningOutcome = "ready";
// Optional gate holding the provisioning wait open, so a test can assert
// `ready` stays false for as long as the resize hasn't converged.
let provisioningGate: Promise<void> | null = null;
const holdProvisioning = (): (() => void) => {
  let release!: () => void;
  provisioningGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
};
const awaitPurchasedProvisioningMock = mock(
  async (_options: unknown): Promise<PurchasedProvisioningOutcome> => {
    if (provisioningGate) {
      await provisioningGate;
    }
    return provisioningOutcome;
  },
);
// The hook reads the poll cadence and the wait ceiling from this module too
// (single-sourced); a short interval keeps the poll-loop tests fast.
mock.module("@/domains/onboarding/purchased-provisioning", () => ({
  awaitPurchasedProvisioning: awaitPurchasedProvisioningMock,
  POLL_INTERVAL_MS: 10,
  MAX_HATCH_WAIT_MS: 300_000,
}));

const seedHatchAvatarMock = mock(
  async (_id: string, _traits: unknown, _queryClient: unknown): Promise<void> =>
    undefined,
);
mock.module("@/assistant/seed-hatch-avatar", () => ({
  seedHatchAvatar: seedHatchAvatarMock,
}));

const stableQueryClient = {};
mock.module("@tanstack/react-query", () => ({
  useQueryClient: () => stableQueryClient,
}));

const { useBackgroundHatch } = await import("./use-background-hatch");

const TIMEOUT_MESSAGE =
  "Your assistant is taking longer than expected. Please try again.";
const ORG_HEADER_MESSAGE =
  "We couldn't confirm your organization. Please try again.";

/**
 * Poll a predicate without depending on the hook's own poll cadence, rejecting
 * if it never holds. An absence is asserted with `.rejects`, so a slow machine
 * only lengthens the wait instead of changing the verdict.
 */
async function until(predicate: () => boolean, timeoutMs = 300): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("condition never became true");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  hatchResult = {
    ok: true,
    status: 201,
    data: { id: "ast-research" } as never,
  };
  getAssistantResult = {
    ok: true,
    status: 200,
    data: {
      id: "ast-research",
      name: "Research",
      status: "active",
      is_local: false,
    } as never,
  };
  healthzResult = { ok: true, status: 200, data: {} as never };
  lockfileEntries = {};
  localMode = false;
  provisioningOutcome = "ready";
  provisioningGate = null;
  orgReadiness = "ready";
  fetchOrganizationsMock.mockClear();
  saveLockfileAssistantMock.mockClear();
  hatchAssistantMock.mockClear();
  getAssistantMock.mockClear();
  getAssistantHealthzMock.mockClear();
  probeLocalGatewayReadyMock.mockClear();
  getLockfileAssistantMock.mockClear();
  awaitPurchasedProvisioningMock.mockClear();
  seedHatchAvatarMock.mockClear();
  clearGatewayTokenMock.mockClear();
  setSelfHostedConnectionMock.mockClear();
  clearsAtHatch = { gateway: 0, selfHosted: 0 };
});

describe("useBackgroundHatch", () => {
  test("start() called twice hatches once", async () => {
    const { result } = renderHook(() => useBackgroundHatch());

    act(() => {
      result.current.start();
      result.current.start();
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(hatchAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("awaitReady() resolves to the id after health passes", async () => {
    const { result } = renderHook(() => useBackgroundHatch());

    let resolved: string | undefined;
    act(() => {
      void result.current.awaitReady().then((id) => {
        resolved = id;
      });
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.assistantId).toBe("ast-research");
    await waitFor(() => expect(resolved).toBe("ast-research"));
    // ready flips only after the health check passes, not on hatch return.
    expect(getAssistantHealthzMock).toHaveBeenCalledTimes(1);
  });

  test("terminal hatch failure surfaces error and rejects awaitReady()", async () => {
    hatchResult = {
      ok: false,
      status: 400,
      error: { detail: "Bad hatch request" },
    };

    const { result } = renderHook(() => useBackgroundHatch());

    let rejection: Error | undefined;
    act(() => {
      void result.current.awaitReady().catch((err: Error) => {
        rejection = err;
      });
      result.current.start();
    });

    await waitFor(() => expect(result.current.error).toBe("Bad hatch request"));
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(rejection?.message).toBe("Bad hatch request"));
    // A terminal (non-5xx) hatch failure must not fall through to polling.
    expect(getAssistantMock).not.toHaveBeenCalled();
  });

  test("adopting a lockfile-known id settles ready immediately, with no discovery", async () => {
    // The hatching screen provisioned this assistant in the foreground and
    // verified gateway readiness before handing off, so a live lockfile entry
    // for the handed-off id is adopted as ready outright — no managed hatch,
    // no getAssistant poll (which could wedge on the platform when the gateway
    // token isn't observable yet), no readyz probe, no "Waking up" gate.
    lockfileEntries["ast-research"] = { assistantId: "ast-research" };

    const { result } = renderHook(() =>
      useBackgroundHatch({
        adoptExisting: true,
        adoptAssistantId: "ast-research",
      }),
    );

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.assistantId).toBe("ast-research");
    expect(hatchAssistantMock).not.toHaveBeenCalled();
    expect(getAssistantMock).not.toHaveBeenCalled();
    expect(probeLocalGatewayReadyMock).not.toHaveBeenCalled();
    expect(getAssistantHealthzMock).not.toHaveBeenCalled();
  });

  test("session-fallback adopt (no handed-off id) still discovers and probes readyz", async () => {
    // A refresh / direct visit adopts on session evidence alone — a cached
    // gateway token proves nothing about the gateway process still being
    // alive, so discovery and the local readyz probe must still run.
    const { result } = renderHook(() =>
      useBackgroundHatch({ adoptExisting: true }),
    );

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(hatchAssistantMock).not.toHaveBeenCalled();
    expect(getAssistantMock).toHaveBeenCalledWith(undefined);
    expect(probeLocalGatewayReadyMock).toHaveBeenCalled();
    expect(getAssistantHealthzMock).not.toHaveBeenCalled();
    expect(result.current.assistantId).toBe("ast-research");
  });

  test("adopting with a stale id falls back to list-based discovery", async () => {
    // The pinned id 404s (e.g. the lockfile entry was retired between the
    // hatching screen and here) — discovery must recover via the no-arg
    // getAssistant() fallback instead of failing the adopt.
    getAssistantMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 404,
      error: {},
    }));

    const { result } = renderHook(() =>
      useBackgroundHatch({
        adoptExisting: true,
        adoptAssistantId: "ast-stale",
      }),
    );

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(getAssistantMock.mock.calls[0]).toEqual(["ast-stale"]);
    // The 404 fallback re-discovers without an id.
    expect(getAssistantMock.mock.calls[1]).toEqual([]);
    expect(result.current.assistantId).toBe("ast-research");
  });

  test("default (managed) runs hatchAssistant", async () => {
    const { result } = renderHook(() => useBackgroundHatch());

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    // Vellum-Cloud / managed path still provisions via hatchAssistant.
    expect(hatchAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("post-checkout return withholds ready until the provisioning wait resolves", async () => {
    const release = holdProvisioning();

    const { result } = renderHook(() =>
      useBackgroundHatch({ postCheckoutReturn: true }),
    );

    let resolved: string | undefined;
    act(() => {
      void result.current.awaitReady().then((id) => {
        resolved = id;
      });
      result.current.start();
    });

    await waitFor(() =>
      expect(awaitPurchasedProvisioningMock).toHaveBeenCalledTimes(1),
    );
    // The wait runs AFTER healthz passes, and holds `ready` while pending.
    expect(getAssistantHealthzMock).toHaveBeenCalledTimes(1);
    expect(awaitPurchasedProvisioningMock.mock.calls[0][0]).toMatchObject({
      assistantId: "ast-research",
      postCheckoutReturn: true,
      managedHatch: true,
    });
    expect(result.current.ready).toBe(false);
    expect(resolved).toBeUndefined();

    await act(async () => {
      release();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    await waitFor(() => expect(resolved).toBe("ast-research"));
  });

  test("a health_timeout from the provisioning wait fails the hatch", async () => {
    provisioningOutcome = "health_timeout";

    const { result } = renderHook(() =>
      useBackgroundHatch({ postCheckoutReturn: true }),
    );

    let rejection: Error | undefined;
    act(() => {
      void result.current.awaitReady().catch((err: Error) => {
        rejection = err;
      });
      result.current.start();
    });

    await waitFor(() => expect(result.current.error).toBe(TIMEOUT_MESSAGE));
    // A resize the assistant never came back from is a failure, never a
    // completion onto an unreachable pod.
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(rejection?.message).toBe(TIMEOUT_MESSAGE));
  });

  test("the free path never runs the purchased-provisioning wait", async () => {
    const { result } = renderHook(() => useBackgroundHatch());

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    // No subscription polling and no avatar seed without the paid marker.
    expect(awaitPurchasedProvisioningMock).not.toHaveBeenCalled();
    expect(seedHatchAvatarMock).not.toHaveBeenCalled();
  });

  test("retry() re-runs the hatch after a terminal failure", async () => {
    hatchResult = {
      ok: false,
      status: 400,
      error: { detail: "Bad hatch request" },
    };

    const { result } = renderHook(() => useBackgroundHatch());

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.error).toBe("Bad hatch request"));

    hatchResult = {
      ok: true,
      status: 201,
      data: { id: "ast-research" } as never,
    };

    let resolved: string | undefined;
    act(() => {
      result.current.retry();
      // Waiters from the failed attempt were already rejected, so callers
      // re-await after retrying.
      void result.current.awaitReady().then((id) => {
        resolved = id;
      });
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBeNull();
    expect(result.current.assistantId).toBe("ast-research");
    expect(hatchAssistantMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(resolved).toBe("ast-research"));

    // The restarted hatch is ref-guarded again.
    act(() => {
      result.current.start();
    });
    expect(hatchAssistantMock).toHaveBeenCalledTimes(2);
  });

  test("a 201 paid hatch seeds the avatar; an existing (200) one does not", async () => {
    const fresh = renderHook(() =>
      useBackgroundHatch({ postCheckoutReturn: true }),
    );

    act(() => {
      fresh.result.current.start();
    });

    await waitFor(() => expect(fresh.result.current.ready).toBe(true));
    expect(seedHatchAvatarMock).toHaveBeenCalledTimes(1);
    expect(seedHatchAvatarMock.mock.calls[0][0]).toBe("ast-research");

    seedHatchAvatarMock.mockClear();
    hatchResult = {
      ok: true,
      status: 200,
      data: { id: "ast-research" } as never,
    };

    const existing = renderHook(() =>
      useBackgroundHatch({ postCheckoutReturn: true }),
    );

    act(() => {
      existing.result.current.start();
    });

    await waitFor(() => expect(existing.result.current.ready).toBe(true));
    // A returning user may have a real avatar; only a fresh hatch is seeded.
    expect(seedHatchAvatarMock).not.toHaveBeenCalled();
  });

  test("unmounting stops the assistant poll loop", async () => {
    // Local mode so the discovery branch would write the lockfile — which sets
    // the ACTIVE assistant, and is not covered by `settleReady`'s own guard.
    localMode = true;
    getAssistantResult = {
      ok: true,
      status: 200,
      data: {
        id: "ast-research",
        status: "initializing",
        is_local: false,
      } as never,
    };

    const { result, unmount } = renderHook(() => useBackgroundHatch());

    act(() => {
      result.current.start();
    });

    await waitFor(() =>
      expect(getAssistantMock.mock.calls.length).toBeGreaterThanOrEqual(2),
    );

    // Hold one poll open across the unmount, then answer it `active` — the
    // response a departed hatch would otherwise claim the assistant on.
    let releasePoll!: () => void;
    let pollStarted = false;
    const heldPoll = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    getAssistantMock.mockImplementationOnce(async () => {
      pollStarted = true;
      await heldPoll;
      return {
        ok: true,
        status: 200,
        data: {
          id: "ast-research",
          name: "Research",
          status: "active",
          is_local: false,
        } as never,
      };
    });
    await until(() => pollStarted);

    unmount();
    const callsAtUnmount = getAssistantMock.mock.calls.length;
    await act(async () => {
      releasePoll();
    });

    // Leaving the funnel mid-hatch must not keep polling from a dead
    // component — the aborted sleep schedules no timer to poll from — and the
    // late answer must not switch the user's active assistant.
    await expect(
      until(() => getAssistantMock.mock.calls.length > callsAtUnmount),
    ).rejects.toThrow();
    expect(saveLockfileAssistantMock).not.toHaveBeenCalled();
  });

  test("unmounting during the initial hatch never settles", async () => {
    // A terminal failure is the sharpest case: it settles straight from the
    // hatch response, without a poll-loop check in between.
    hatchResult = {
      ok: false,
      status: 400,
      error: { detail: "Bad hatch request" },
    };
    let releaseHatch!: () => void;
    hatchAssistantMock.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseHatch = resolve;
      });
      return hatchResult;
    });

    const { result, unmount } = renderHook(() => useBackgroundHatch());

    let resolved: string | undefined;
    let rejection: Error | undefined;
    act(() => {
      void result.current.awaitReady().then(
        (id) => {
          resolved = id;
        },
        (err: Error) => {
          rejection = err;
        },
      );
      result.current.start();
    });

    await waitFor(() => expect(hatchAssistantMock).toHaveBeenCalledTimes(1));
    unmount();

    // The hatch response lands after the component is gone, so it settles
    // nothing — the waiters of a hook nobody is watching stay pending.
    await act(async () => {
      releaseHatch();
    });
    await expect(
      until(() => resolved != null || rejection != null),
    ).rejects.toThrow();
  });

  test("unmounting cancels the purchased-provisioning wait without settling", async () => {
    const release = holdProvisioning();

    const { result, unmount } = renderHook(() =>
      useBackgroundHatch({ postCheckoutReturn: true }),
    );

    let resolved: string | undefined;
    act(() => {
      void result.current.awaitReady().then((id) => {
        resolved = id;
      });
      result.current.start();
    });

    await waitFor(() =>
      expect(awaitPurchasedProvisioningMock).toHaveBeenCalledTimes(1),
    );
    const options = awaitPurchasedProvisioningMock.mock.calls[0][0] as {
      isCancelled: () => boolean;
      registerTimer?: (timer: ReturnType<typeof setTimeout> | null) => void;
    };
    expect(options.isCancelled()).toBe(false);
    // The wait's own poll timer has to be clearable from the caller.
    expect(typeof options.registerTimer).toBe("function");

    unmount();
    expect(options.isCancelled()).toBe(true);

    // A cancelled wait still resolves "ready"; the hatch must not complete on
    // it once the component is gone.
    await act(async () => {
      release();
    });
    expect(resolved).toBeUndefined();
  });

  test("a managed hatch in local mode records the assistant in the lockfile", async () => {
    // The desktop build's assistant list and switcher are lockfile-driven, so
    // a headless managed hatch has to register there like the foreground one.
    localMode = true;

    const { result } = renderHook(() => useBackgroundHatch());

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(saveLockfileAssistantMock).toHaveBeenCalledTimes(1);
    expect(saveLockfileAssistantMock.mock.calls[0][0]).toMatchObject({
      assistantId: "ast-research",
      name: "Research",
      cloud: "vellum",
      runtimeUrl: "https://runtime.example",
      organizationId: "org-1",
    });

    // Adopting a foreground-hatched assistant is the hatching screen's own
    // write; the background hatch must not duplicate it.
    saveLockfileAssistantMock.mockClear();
    const adopt = renderHook(() => useBackgroundHatch({ adoptExisting: true }));

    act(() => {
      adopt.result.current.start();
    });

    await waitFor(() => expect(adopt.result.current.ready).toBe(true));
    expect(saveLockfileAssistantMock).not.toHaveBeenCalled();
  });

  test("a non-local build writes no lockfile entry", async () => {
    const { result } = renderHook(() => useBackgroundHatch());

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(saveLockfileAssistantMock).not.toHaveBeenCalled();
  });

  // -- local gateway routing ------------------------------------------------
  //
  // The paid funnel routes an org whose only assistants are local/self-hosted
  // to the managed hatch (`hosting=vellum-cloud`), so `adoptExisting` is false
  // while the desktop build still holds a live gateway token and a primed
  // self-hosted connection. Both would rewrite discovery, healthz and the
  // onboarding writes to the old local gateway.

  test("a managed hatch in local mode drops the local gateway before the hatch POST", async () => {
    localMode = true;

    const { result } = renderHook(() => useBackgroundHatch());

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(clearGatewayTokenMock).toHaveBeenCalledTimes(1);
    expect(setSelfHostedConnectionMock).toHaveBeenCalledWith(null);
    expect(clearsAtHatch).toEqual({ gateway: 1, selfHosted: 1 });
  });

  test("an adopting hatch keeps its gateway session", async () => {
    // Adoption resolves the live local assistant through that very session —
    // dropping it would strand the flow on an unreachable gateway.
    localMode = true;

    const { result } = renderHook(() =>
      useBackgroundHatch({ adoptExisting: true }),
    );

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(clearGatewayTokenMock).not.toHaveBeenCalled();
    expect(setSelfHostedConnectionMock).not.toHaveBeenCalled();
  });

  test("a non-local build leaves the routing state untouched", async () => {
    // In a browser there is no local gateway to address, so the free web hatch
    // makes no routing write at all.
    const { result } = renderHook(() => useBackgroundHatch());

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(clearGatewayTokenMock).not.toHaveBeenCalled();
    expect(setSelfHostedConnectionMock).not.toHaveBeenCalled();
  });

  test("retry() re-clears the routing state harmlessly", async () => {
    localMode = true;
    hatchResult = {
      ok: false,
      status: 400,
      error: { detail: "Bad hatch request" },
    };

    const { result } = renderHook(() => useBackgroundHatch());

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.error).toBe("Bad hatch request"));
    expect(clearsAtHatch).toEqual({ gateway: 1, selfHosted: 1 });

    hatchResult = {
      ok: true,
      status: 201,
      data: { id: "ast-research" } as never,
    };

    act(() => {
      result.current.retry();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(clearsAtHatch).toEqual({ gateway: 2, selfHosted: 2 });
    expect(setSelfHostedConnectionMock.mock.calls).toEqual([[null], [null]]);
  });

  // -- org header readiness -------------------------------------------------
  //
  // Every platform call here is scoped by `Vellum-Organization-Id`, sourced
  // from a store that hydrates after auth. A checkout deep link can relaunch
  // the app straight into this hook before that lands, so the managed sequence
  // holds until the header source can answer.

  test("a warm org store costs the managed hatch no delay", async () => {
    // Microtasks only — no timer elapses — so a POST here proves the wait
    // short-circuits on its first synchronous check.
    const { result } = renderHook(() => useBackgroundHatch());

    await act(async () => {
      result.current.start();
    });

    expect(hatchAssistantMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.ready).toBe(true));
  });

  test("the managed hatch holds its POST until the org header resolves", async () => {
    orgReadiness = "resolving";

    const { result } = renderHook(() => useBackgroundHatch());

    act(() => {
      result.current.start();
    });

    // Nothing may address the platform while the header source is unresolved.
    // Sampled well inside the wait's ceiling, so the absence is the hold rather
    // than a hatch that already gave up.
    await expect(
      until(() => hatchAssistantMock.mock.calls.length > 0, 60),
    ).rejects.toThrow();
    expect(result.current.error).toBeNull();

    orgReadiness = "ready";

    await waitFor(() => expect(hatchAssistantMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.ready).toBe(true));
  });

  test("an org header that never settles fails the hatch, retryably", async () => {
    orgReadiness = "resolving";

    const { result } = renderHook(() => useBackgroundHatch());

    let rejection: Error | undefined;
    act(() => {
      void result.current.awaitReady().catch((err: Error) => {
        rejection = err;
      });
      result.current.start();
    });

    await waitFor(() => expect(result.current.error).toBe(ORG_HEADER_MESSAGE));
    // A header-less hatch would be rejected by the platform, so none is sent.
    expect(hatchAssistantMock).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
    await waitFor(() => expect(rejection?.message).toBe(ORG_HEADER_MESSAGE));

    // The banner's retry re-runs the wait, which passes once hydration lands.
    orgReadiness = "ready";
    act(() => {
      result.current.retry();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBeNull();
    expect(hatchAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("concluded org resolution is re-run once before the hatch fails", async () => {
    orgReadiness = "unavailable";

    const { result } = renderHook(() => useBackgroundHatch());

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.error).toBe(ORG_HEADER_MESSAGE));
    // Resolution that already ended without an id is never arriving on its own,
    // so the wait kicks it once — and stops rather than waiting forever.
    expect(fetchOrganizationsMock).toHaveBeenCalledTimes(1);
    expect(hatchAssistantMock).not.toHaveBeenCalled();
  });

  test("the first attempt waits out in-flight resolution without kicking it", async () => {
    orgReadiness = "resolving";

    const { result } = renderHook(() => useBackgroundHatch());

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.error).toBe(ORG_HEADER_MESSAGE));
    // A cold boot resolves the org on its own; a duplicate request here would
    // only race the store's own hydration.
    expect(fetchOrganizationsMock).not.toHaveBeenCalled();
  });

  test("a retry supersedes resolution still in flight past the ceiling", async () => {
    orgReadiness = "resolving";

    const { result } = renderHook(() => useBackgroundHatch());

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.error).toBe(ORG_HEADER_MESSAGE));

    act(() => {
      result.current.retry();
    });

    // A fetch still pending past the ceiling is a stalled request the store
    // will never time out, so the retry replaces it rather than waiting again.
    await waitFor(() =>
      expect(fetchOrganizationsMock).toHaveBeenCalledTimes(1),
    );
    // The replacement answering mid-wait lets the held hatch proceed.
    orgReadiness = "ready";

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBeNull();
    expect(hatchAssistantMock).toHaveBeenCalledTimes(1);
  });

  test("a retry whose replacement fetch also hangs fails once more", async () => {
    orgReadiness = "resolving";

    const { result } = renderHook(() => useBackgroundHatch());

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.error).toBe(ORG_HEADER_MESSAGE));

    act(() => {
      result.current.retry();
    });

    await waitFor(() => expect(result.current.error).toBe(ORG_HEADER_MESSAGE));
    // One kick per attempt — a wedged network can't turn the wait into a
    // request loop.
    expect(fetchOrganizationsMock).toHaveBeenCalledTimes(1);
    expect(hatchAssistantMock).not.toHaveBeenCalled();
  });

  test("unmounting during the org wait settles nothing", async () => {
    orgReadiness = "resolving";

    const { result, unmount } = renderHook(() => useBackgroundHatch());

    let resolved: string | undefined;
    let rejection: Error | undefined;
    act(() => {
      void result.current.awaitReady().then(
        (id) => {
          resolved = id;
        },
        (err: Error) => {
          rejection = err;
        },
      );
      result.current.start();
    });

    unmount();
    orgReadiness = "ready";

    // The aborted sleep schedules no timer, so the wait never reaches the
    // header it was holding for, and the departed hatch neither POSTs nor
    // settles its waiters.
    await expect(
      until(() => resolved != null || rejection != null),
    ).rejects.toThrow();
    expect(hatchAssistantMock).not.toHaveBeenCalled();
  });

  test("the adopt path skips the org wait", async () => {
    // The assistant is already live and adoption resolves it through the local
    // gateway, so an unresolved platform org can't hold that hand-off.
    orgReadiness = "unavailable";

    const { result } = renderHook(() =>
      useBackgroundHatch({ adoptExisting: true }),
    );

    act(() => {
      result.current.start();
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.error).toBeNull();
    expect(fetchOrganizationsMock).not.toHaveBeenCalled();
  });
});
