/**
 * `useShareApp` is the one share handler both app menus call. What it owns is
 * the sequence: refuse a second export while one is running, name the bundle
 * after the app, and raise the caller's own copy either way.
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
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import * as toastModule from "@vellumai/design-library/components/toast";

import type { AppSummary } from "@/types/app-types";

interface RaisedToast {
  title: string;
  description?: string;
}

let successes: RaisedToast[] = [];
let errors: RaisedToast[] = [];
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
      await result.current.share();
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
      await result.current.share();
    });

    expect(errors).toEqual([
      { title: "Export failed", description: "no bundle" },
    ]);
    expect(successes).toHaveLength(0);
  });

  test("ignores a second request while one is still in flight", async () => {
    let release = () => {};
    shareResult = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { result } = renderShare();

    let firstShare: Promise<void> = Promise.resolve();
    act(() => {
      firstShare = result.current.share();
    });
    await waitFor(() => {
      expect(result.current.isSharing).toBe(true);
    });

    await act(async () => {
      await result.current.share();
    });
    expect(shareCalls).toHaveLength(1);

    await act(async () => {
      release();
      await firstShare;
    });
    expect(result.current.isSharing).toBe(false);
    expect(successes).toHaveLength(1);
  });
});
