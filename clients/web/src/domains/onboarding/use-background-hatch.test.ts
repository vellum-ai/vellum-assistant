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
  hatchAssistantMock.mockClear();
  getAssistantMock.mockClear();
  getAssistantHealthzMock.mockClear();
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

  test("adoptExisting skips the managed hatch and adopts the live assistant", async () => {
    // A local-hosting onboarding provisions the assistant in the hatching screen
    // before the research flow mounts, so the background hatch must skip the
    // managed `hatchAssistant()` and discover the already-active assistant via
    // getAssistant().
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
    // No managed hatch when adopting…
    expect(hatchAssistantMock).not.toHaveBeenCalled();
    // …the existing assistant is discovered via getAssistant, pinned to the
    // id the hatching screen handed off…
    expect(getAssistantMock).toHaveBeenCalledWith("ast-research");
    // …and the assistant-scoped healthz is SKIPPED (the hatching screen already
    // confirmed the local gateway's /readyz, and that SDK call doesn't resolve
    // against a local gateway anyway).
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
