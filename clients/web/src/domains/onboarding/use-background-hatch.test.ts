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

const hatchAssistantMock = mock(async (): Promise<HatchResult> => hatchResult);
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
mock.module("@/lib/local-mode", () => ({
  probeLocalGatewayReady: probeLocalGatewayReadyMock,
  getLockfileAssistant: getLockfileAssistantMock,
}));
mock.module("@/utils/api-errors", () => ({
  extractErrorMessage: (e: unknown, _r: unknown, fallback?: string) =>
    e &&
    typeof e === "object" &&
    typeof (e as { detail?: unknown }).detail === "string"
      ? (e as { detail: string }).detail
      : (fallback ?? "error"),
}));

const { useBackgroundHatch } = await import("./use-background-hatch");

beforeEach(() => {
  hatchResult = { ok: true, status: 201, data: { id: "ast-research" } as never };
  getAssistantResult = {
    ok: true,
    status: 200,
    data: { id: "ast-research", status: "active", is_local: false } as never,
  };
  healthzResult = { ok: true, status: 200, data: {} as never };
  lockfileEntries = {};
  hatchAssistantMock.mockClear();
  getAssistantMock.mockClear();
  getAssistantHealthzMock.mockClear();
  probeLocalGatewayReadyMock.mockClear();
  getLockfileAssistantMock.mockClear();
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
});
