/**
 * `useShareApp` is the one share handler both app menus call. What it owns is
 * the guard: refuse a second export while one is running. The sequence it
 * wraps names the bundle after the app and raises the caller's own copy
 * either way.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import * as toastModule from "@vellumai/design-library/components/toast";

import * as captureErrorModule from "@/lib/sentry/capture-error";
import type { AppSummary } from "@/types/app-types";

interface RaisedToast {
  title: string;
  description?: string;
}

interface CapturedError {
  err: unknown;
  context?: string;
}

let successes: RaisedToast[] = [];
let errors: RaisedToast[] = [];
let captured: CapturedError[] = [];
let shareCalls: Array<[string, string, string]> = [];
let shareResult: Promise<void> = Promise.resolve();

mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: {
    success: (title: string, options?: { description?: string }) => {
      successes.push({ title, description: options?.description });
    },
    error: (title: string, options?: { description?: string }) => {
      errors.push({ title, description: options?.description });
    },
  },
}));

mock.module("@/lib/sentry/capture-error", () => ({
  ...captureErrorModule,
  captureError: (err: unknown, options?: { context?: string }) => {
    captured.push({ err, context: options?.context });
  },
}));

mock.module("@/utils/share-app", () => ({
  shareApp: (assistantId: string, appId: string, appName: string) => {
    shareCalls.push([assistantId, appId, appName]);
    return shareResult;
  },
}));

const { useShareApp } = await import("@/hooks/use-share-app");

const ASSISTANT_ID = "asst-1";
const APP = { id: "app-1", name: "Trip Planner" } as AppSummary;
const COPY = { exported: "Exported", failed: "Export failed" };

function renderShare() {
  return renderHook(() => useShareApp(ASSISTANT_ID, APP, COPY));
}

beforeEach(() => {
  successes = [];
  errors = [];
  captured = [];
  shareCalls = [];
  shareResult = Promise.resolve();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  mock.restore();
});

describe("useShareApp", () => {
  test("exports the app and names the bundle after it", async () => {
    const { result } = renderShare();

    await act(async () => {
      await result.current();
    });

    expect(shareCalls).toEqual([[ASSISTANT_ID, "app-1", "Trip Planner"]]);
    expect(successes).toEqual([
      { title: "Exported", description: "Trip Planner.vellum" },
    ]);
    expect(errors).toHaveLength(0);
  });

  test("reports the failure with the caller's copy and the error's message", async () => {
    shareResult = Promise.reject(new Error("no bundle"));
    const { result } = renderShare();

    await act(async () => {
      await result.current();
    });

    expect(errors).toEqual([
      { title: "Export failed", description: "no bundle" },
    ]);
    expect(successes).toHaveLength(0);
  });

  test("reports the failure to Sentry as well as the toast", async () => {
    const failure = new Error("no bundle");
    shareResult = Promise.reject(failure);
    const { result } = renderShare();

    await act(async () => {
      await result.current();
    });

    expect(captured).toEqual([{ err: failure, context: "shareAppWithToast" }]);
  });

  test("ignores a second request while one is still in flight", async () => {
    let release = () => {};
    shareResult = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { result } = renderShare();

    let firstShare: Promise<void> = Promise.resolve();
    act(() => {
      firstShare = result.current();
    });

    await act(async () => {
      await result.current();
    });
    expect(shareCalls).toHaveLength(1);

    await act(async () => {
      release();
      await firstShare;
    });
    expect(successes).toHaveLength(1);
  });

  test("takes the next request once the export has finished", async () => {
    const { result } = renderShare();

    await act(async () => {
      await result.current();
    });
    await act(async () => {
      await result.current();
    });

    expect(shareCalls).toHaveLength(2);
  });

  test("keeps one share handler across the export", async () => {
    let release = () => {};
    shareResult = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { result } = renderShare();
    const before = result.current;

    let firstShare: Promise<void> = Promise.resolve();
    act(() => {
      firstShare = result.current();
    });
    await act(async () => {
      release();
      await firstShare;
    });

    expect(result.current).toBe(before);
  });
});
