/**
 * Tests for the headless `TimezoneSync` component.
 *
 * Strategy: mock the generated API client's `patch`, the browser-zone and
 * device-setting readers (separately), and the effective-timezone hook
 * (the reactivity trigger), drive the active assistant id through the real
 * selection store, and assert the PATCH writes both `detectedTimezone`
 * (browser zone) and `userTimezone` (override or "") and never persists a
 * stale zone when requests overlap.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { useAssistantSelectionStore } from "@/assistant/selection-store";
import { publish } from "@/lib/event-bus";

interface PatchArgs {
  url: string;
  path: { assistant_id: string };
  body: { ui: Record<string, unknown> };
}

// Mutable separate readers; tests flip them then re-render. `browserTz`
// is the live auto zone; `override` is the manual `device:timezone`.
let browserTz = "America/New_York";
let override = "";
const patchMock = mock(async (_args: PatchArgs) => ({ data: {} }));
const captureErrorMock = mock((_error: unknown, _opts: { context: string }) => {});

// The hook is just a reactivity trigger; it folds override over browser
// zone (matching the real implementation) so a flip of either re-renders.
mock.module("@/utils/use-effective-timezone", () => ({
  useEffectiveTimezone: () => (override.trim() ? override.trim() : browserTz),
}));

mock.module("@/utils/browser-timezone", () => ({
  getBrowserTimezone: () => browserTz,
}));

mock.module("@/utils/device-settings", () => ({
  getDeviceSetting: (_name: string, fallback: string) =>
    override === "" ? fallback : override,
}));

mock.module("@/generated/api/client.gen", () => ({
  client: { patch: patchMock },
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

const { TimezoneSync } = await import("@/components/timezone-sync");

function renderSync() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<TimezoneSync />, { wrapper: Wrapper });
}

beforeEach(() => {
  browserTz = "America/New_York";
  override = "";
  patchMock.mockClear();
  captureErrorMock.mockClear();
  patchMock.mockImplementation(async () => ({ data: {} }));
  useAssistantSelectionStore.setState({ activeAssistantId: "asst-1" });
});

afterEach(() => {
  cleanup();
  useAssistantSelectionStore.setState({ activeAssistantId: null });
});

function lastBody() {
  return patchMock.mock.calls.at(-1)?.[0]?.body;
}

describe("TimezoneSync", () => {
  test("PATCHes both fields once on mount in auto mode (userTimezone cleared)", async () => {
    renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    const call = patchMock.mock.calls[0]![0];
    expect(call.url).toBe("/v1/assistants/{assistant_id}/config");
    expect(call.path).toEqual({ assistant_id: "asst-1" });
    expect(call.body).toEqual({
      ui: { detectedTimezone: "America/New_York", userTimezone: "" },
    });
  });

  test("manual override is written to userTimezone; detectedTimezone carries the live browser zone", async () => {
    override = "Asia/Tokyo";
    renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({
      ui: { detectedTimezone: "America/New_York", userTimezone: "Asia/Tokyo" },
    });
  });

  test("trims the override before writing userTimezone", async () => {
    override = "  Asia/Tokyo  ";
    renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(lastBody()).toEqual({
      ui: { detectedTimezone: "America/New_York", userTimezone: "Asia/Tokyo" },
    });
  });

  test("a browser-zone change triggers exactly one additional PATCH with the new zone", async () => {
    const { rerender } = renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));

    browserTz = "Europe/London";
    rerender(<TimezoneSync />);

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
    expect(lastBody()).toEqual({
      ui: { detectedTimezone: "Europe/London", userTimezone: "" },
    });
  });

  test("no additional PATCH when nothing changed across re-renders (redundant-key dedupe)", async () => {
    const { rerender } = renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));

    rerender(<TimezoneSync />);
    rerender(<TimezoneSync />);

    await new Promise((r) => setTimeout(r, 10));
    expect(patchMock).toHaveBeenCalledTimes(1);
  });

  test("no PATCH when the browser zone is empty", async () => {
    browserTz = "";
    renderSync();
    await new Promise((r) => setTimeout(r, 10));
    expect(patchMock).not.toHaveBeenCalled();
  });

  test("no PATCH when no assistant id is available", async () => {
    useAssistantSelectionStore.setState({ activeAssistantId: null });
    renderSync();
    await new Promise((r) => setTimeout(r, 10));
    expect(patchMock).not.toHaveBeenCalled();
  });

  test("captures errors silently and allows a later retry of the failed zone", async () => {
    patchMock.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const { rerender } = renderSync();
    await waitFor(() => expect(captureErrorMock).toHaveBeenCalledTimes(1));
    expect(captureErrorMock.mock.calls[0]![1]).toEqual({
      context: "timezone-sync",
    });

    browserTz = "Europe/London";
    rerender(<TimezoneSync />);
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));

    browserTz = "America/New_York";
    rerender(<TimezoneSync />);
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(3));
    expect(lastBody()).toEqual({
      ui: { detectedTimezone: "America/New_York", userTimezone: "" },
    });
  });

  test("retries on app.resume with the same zone after a failed initial sync", async () => {
    patchMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    renderSync();
    await waitFor(() => expect(captureErrorMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));

    publish("app.resume", { signal: "visibility" });
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
    expect(lastBody()).toEqual({
      ui: { detectedTimezone: "America/New_York", userTimezone: "" },
    });
  });

  test("retries on window focus with the same zone after a failed initial sync", async () => {
    patchMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(captureErrorMock).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
    expect(lastBody()).toEqual({
      ui: { detectedTimezone: "America/New_York", userTimezone: "" },
    });
  });

  test("does not re-PATCH on resume/focus after a successful sync with the same zone", async () => {
    renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));

    publish("app.resume", { signal: "visibility" });
    window.dispatchEvent(new Event("focus"));

    await new Promise((r) => setTimeout(r, 10));
    expect(patchMock).toHaveBeenCalledTimes(1);
  });

  test("last-writer-wins: a slow older PATCH cannot overwrite a newer zone", async () => {
    // Two overlapping triggers; the FIRST (older zone) resolves AFTER the
    // SECOND (newer zone). The final synced state must reflect the newer
    // zone, and the stale older completion must not re-open it for resync.
    const resolvers: Array<() => void> = [];
    patchMock.mockImplementation(
      () =>
        new Promise<{ data: Record<string, unknown> }>((resolve) => {
          resolvers.push(() => resolve({ data: {} }));
        }),
    );

    const { rerender } = renderSync();
    // First PATCH issued (mount) for America/New_York; still pending.
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));

    // Zone flips before the first request settles → second PATCH issued.
    browserTz = "Europe/London";
    rerender(<TimezoneSync />);
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));

    expect(resolvers).toHaveLength(2);
    // Newer request resolves first, then the stale older one resolves last.
    resolvers[1]!();
    resolvers[0]!();
    await new Promise((r) => setTimeout(r, 10));

    // The newer zone is the synced state: re-rendering with Europe/London
    // (the latest issued key) must NOT trigger a redundant PATCH...
    rerender(<TimezoneSync />);
    await new Promise((r) => setTimeout(r, 10));
    expect(patchMock).toHaveBeenCalledTimes(2);

    // ...and flipping back to the older zone DOES PATCH (so the stale
    // completion never recorded America/New_York as the synced key).
    browserTz = "America/New_York";
    rerender(<TimezoneSync />);
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(3));
    expect(lastBody()).toEqual({
      ui: { detectedTimezone: "America/New_York", userTimezone: "" },
    });
  });
});
