/**
 * Tests for the headless `TimezoneSync` component.
 *
 * Strategy: mock the generated API client's `patch`, the browser-zone reader,
 * and the effective-timezone hook (the reactivity trigger), drive the active
 * assistant id through the real selection store, and assert the PATCH writes
 * ONLY `detectedTimezone` (the live browser zone) and NEVER `userTimezone`,
 * that writes are serialized (no two PATCHes in flight at once), and that the
 * final write always reflects the newest zone when triggers overlap.
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

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { publish } from "@/lib/event-bus";

interface PatchArgs {
  url: string;
  path: { assistant_id: string };
  body: { ui: Record<string, unknown> };
}

// Mutable browser zone; tests flip it then re-render.
let browserTz = "America/New_York";
const patchMock = mock(async (_args: PatchArgs) => ({ data: {} }));

// The hook is just a reactivity trigger; it tracks the browser zone so a flip
// re-renders.
mock.module("@/utils/use-effective-timezone", () => ({
  useEffectiveTimezone: () => browserTz,
}));

mock.module("@/utils/browser-timezone", () => ({
  getBrowserTimezone: () => browserTz,
}));

mock.module("@/generated/api/client.gen", () => ({
  client: { patch: patchMock },
}));

mock.module("@/lib/sentry/capture-error", () => ({
  captureError: () => {},
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
  patchMock.mockClear();
  patchMock.mockImplementation(async () => ({ data: {} }));
  useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
});

afterEach(() => {
  cleanup();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

function lastBody() {
  return patchMock.mock.calls.at(-1)?.[0]?.body;
}

describe("TimezoneSync", () => {
  test("PATCHes only detectedTimezone on mount; never sends userTimezone", async () => {
    renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    const call = patchMock.mock.calls[0]![0];
    expect(call.url).toBe("/v1/assistants/{assistant_id}/config");
    expect(call.path).toEqual({ assistant_id: "asst-1" });
    expect(call.body).toEqual({ ui: { detectedTimezone: "America/New_York" } });
    // Explicitly assert userTimezone is never part of any PATCH body.
    for (const c of patchMock.mock.calls) {
      expect(c[0].body.ui).not.toHaveProperty("userTimezone");
    }
  });

  test("a browser-zone change triggers exactly one additional PATCH with the new zone (no userTimezone)", async () => {
    const { rerender } = renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));

    browserTz = "Europe/London";
    rerender(<TimezoneSync />);

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
    expect(lastBody()).toEqual({ ui: { detectedTimezone: "Europe/London" } });
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
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    renderSync();
    await new Promise((r) => setTimeout(r, 10));
    expect(patchMock).not.toHaveBeenCalled();
  });

  test("swallows errors silently and allows a later retry of the failed zone", async () => {
    patchMock.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const { rerender } = renderSync();
    // Wait for the error and all resulting mutation-state re-renders to
    // fully settle before asserting on subsequent zone-change PATCHes.
    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 200));

    // Zone changes after a failure still trigger PATCHes with the correct body.
    browserTz = "Europe/London";
    rerender(<TimezoneSync />);
    await waitFor(() =>
      expect(lastBody()).toEqual({ ui: { detectedTimezone: "Europe/London" } }),
    );

    browserTz = "America/New_York";
    rerender(<TimezoneSync />);
    await waitFor(() =>
      expect(lastBody()).toEqual({
        ui: { detectedTimezone: "America/New_York" },
      }),
    );
  });

  test("retries on app.resume with the same zone after a failed initial sync", async () => {
    patchMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));

    publish("app.resume", { signal: "visibility" });
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
    expect(lastBody()).toEqual({ ui: { detectedTimezone: "America/New_York" } });
  });

  test("retries on window focus with the same zone after a failed initial sync", async () => {
    patchMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
    expect(lastBody()).toEqual({ ui: { detectedTimezone: "America/New_York" } });
  });

  test("does not re-PATCH on resume/focus after a successful sync with the same zone", async () => {
    renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));

    publish("app.resume", { signal: "visibility" });
    window.dispatchEvent(new Event("focus"));

    await new Promise((r) => setTimeout(r, 10));
    expect(patchMock).toHaveBeenCalledTimes(1);
  });

  test("serializes PATCHes (last-writer-wins): newer zone is the final write, no overlap", async () => {
    // The first PATCH (older zone) is held pending while the zone flips. The
    // serializer must NOT start a second PATCH while the first is in flight;
    // the newer zone is queued and fired only after the first settles, so the
    // FINAL server write reflects the newer zone — even if the first promise
    // resolves after the newer target arrives.
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
    expect(lastBody()).toEqual({ ui: { detectedTimezone: "America/New_York" } });

    // Zone flips before the first request settles. NO second PATCH yet — the
    // first is still in flight, so only ONE PATCH is ever in flight at once.
    browserTz = "Europe/London";
    rerender(<TimezoneSync />);
    await new Promise((r) => setTimeout(r, 10));
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(resolvers).toHaveLength(1);

    // First (older) PATCH settles → queue drains and fires the newer zone.
    resolvers[0]!();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
    expect(lastBody()).toEqual({ ui: { detectedTimezone: "Europe/London" } });
    expect(resolvers).toHaveLength(2);

    // Second (newer) PATCH settles → that is now the synced state.
    resolvers[1]!();
    await new Promise((r) => setTimeout(r, 10));

    // Re-rendering at the newer zone must NOT trigger a redundant PATCH...
    rerender(<TimezoneSync />);
    await new Promise((r) => setTimeout(r, 10));
    expect(patchMock).toHaveBeenCalledTimes(2);

    // ...and flipping back to the older zone DOES PATCH (the older zone was
    // never recorded as the synced key).
    browserTz = "America/New_York";
    rerender(<TimezoneSync />);
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(3));
    resolvers[2]!();
    expect(lastBody()).toEqual({ ui: { detectedTimezone: "America/New_York" } });
  });
});
