import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Regression test for the bug where assistant-scoped flag toggles never
// persisted: the panel read the active assistant id from the platform
// `assistants/active` query (null in local mode), so the store silently
// skipped the gateway PATCH. The fix sources the id from the gate-backed
// resolved-assistants store via `useActiveAssistantId`. This test locks in
// that a toggle issues the PATCH against that id.

const patchMock = mock((_request: unknown) =>
  Promise.resolve({ response: new Response(null, { status: 204 }) }),
);
const getMock = mock((_request: unknown) =>
  Promise.resolve({
    data: { flags: [] },
    response: new Response(null, { status: 200 }),
  }),
);

mock.module("@/generated/api/client.gen", () => ({
  client: { patch: patchMock, get: getMock },
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
}));

// The toast mock must also satisfy the design-library barrel's re-exports:
// the panel pulls `cn` from the barrel index, which re-exports
// `Toaster`/`ToastContent` from this module. Missing exports here surface as
// parse-time "export not found" errors during barrel resolution, so stub them.
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { error: () => {}, success: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

const { FeatureFlagsPanel } = await import("./feature-flags-panel");

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <FeatureFlagsPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  patchMock.mockReset();
  patchMock.mockImplementation((_request: unknown) =>
    Promise.resolve({ response: new Response(null, { status: 204 }) }),
  );
});

afterEach(() => {
  cleanup();
});

describe("FeatureFlagsPanel", () => {
  test("PATCHes an assistant-scoped flag to the active assistant when toggled", () => {
    renderPanel();

    // `memory-retrospective-fork` is an assistant-scoped boolean flag that
    // defaults off — its row renders with the "... is off" label.
    const toggle = screen.getByRole("switch", {
      name: "Fork-based memory retrospective is off",
    });
    fireEvent.click(toggle);

    const request = patchMock.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      url: "/v1/assistants/assistant-1/feature-flags/memory-retrospective-fork",
      body: { enabled: true },
      throwOnError: false,
    });
  });
});
