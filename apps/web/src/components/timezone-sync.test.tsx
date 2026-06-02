/**
 * Tests for the headless `TimezoneSync` component.
 *
 * Strategy: mock the generated API client's `patch` and the effective-
 * timezone hook, drive the active assistant id through the real
 * selection store, and assert the PATCH fires only for genuinely new
 * `{ ui: { detectedTimezone } }` values.
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

// Mutable zone returned by the mocked hook; tests flip it then re-render.
interface PatchArgs {
  url: string;
  path: { assistant_id: string };
  body: { ui: Record<string, unknown> };
}

let currentTz = "America/New_York";
const patchMock = mock(async (_args: PatchArgs) => ({ data: {} }));
const captureErrorMock = mock((_error: unknown, _opts: { context: string }) => {});

// Both the reactive hook and the imperative resume/focus reader resolve
// to the same mutable `currentTz`.
mock.module("@/utils/use-effective-timezone", () => ({
  useEffectiveTimezone: () => currentTz,
}));

mock.module("@/utils/effective-timezone", () => ({
  getEffectiveTimezone: () => currentTz,
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
  currentTz = "America/New_York";
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
  test("PATCHes detectedTimezone once on mount with a resolvable assistant id", async () => {
    renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    const call = patchMock.mock.calls[0]![0];
    expect(call.url).toBe("/v1/assistants/{assistant_id}/config");
    expect(call.path).toEqual({ assistant_id: "asst-1" });
    expect(call.body).toEqual({ ui: { detectedTimezone: "America/New_York" } });
  });

  test("never writes userTimezone", async () => {
    renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(lastBody()?.ui).not.toHaveProperty("userTimezone");
  });

  test("a zone change triggers exactly one additional PATCH with the new zone", async () => {
    const { rerender } = renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));

    currentTz = "Europe/London";
    rerender(<TimezoneSync />);

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
    expect(lastBody()).toEqual({ ui: { detectedTimezone: "Europe/London" } });
  });

  test("no additional PATCH when the zone is unchanged across re-renders", async () => {
    const { rerender } = renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));

    rerender(<TimezoneSync />);
    rerender(<TimezoneSync />);

    // Give any stray effect a chance to fire, then assert it didn't.
    await new Promise((r) => setTimeout(r, 10));
    expect(patchMock).toHaveBeenCalledTimes(1);
  });

  test("no PATCH when the effective zone is empty", async () => {
    currentTz = "";
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
      context: "timezone-sync-detected",
    });

    // The onError handler reset the guard for the failed zone, so the
    // next time that same zone comes back around (after a focus that
    // flips it away and back) it re-syncs instead of being suppressed.
    currentTz = "Europe/London";
    rerender(<TimezoneSync />);
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));

    currentTz = "America/New_York";
    rerender(<TimezoneSync />);
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(3));
    expect(lastBody()).toEqual({ ui: { detectedTimezone: "America/New_York" } });
  });

  test("retries on app.resume with the same zone after a failed initial sync", async () => {
    // Initial sync rejects (e.g. resumed while offline). The guard ref
    // stays unsynced because we only record the key on success.
    patchMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    renderSync();
    await waitFor(() => expect(captureErrorMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));

    // Resume with the SAME zone — a retry must fire even though tz is
    // unchanged (the offline-then-resume case).
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
    await waitFor(() => expect(captureErrorMock).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(2));
    expect(lastBody()).toEqual({ ui: { detectedTimezone: "America/New_York" } });
  });

  test("does not re-PATCH on resume/focus after a successful sync with the same zone", async () => {
    renderSync();
    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));

    // No zone flip: the prior success recorded the key, so both triggers
    // are no-ops (no redundant PATCH).
    publish("app.resume", { signal: "visibility" });
    window.dispatchEvent(new Event("focus"));

    await new Promise((r) => setTimeout(r, 10));
    expect(patchMock).toHaveBeenCalledTimes(1);
  });
});
