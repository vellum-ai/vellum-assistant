/**
 * What the app actually mounts: the modal controller and the pill host.
 *
 * The gates run for real here, driven through the stores they read, because
 * the thing worth proving is that a client the feature is not meant for draws
 * nothing at all. Only the progress read is mocked, at its hook seam, since
 * `use-activation-progress.ts` owns how a snapshot is fetched.
 */

import type { ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import {
  ACTIVATION_PROGRESS_ALL_DONE,
  ACTIVATION_PROGRESS_DISMISSED,
  ACTIVATION_PROGRESS_EMPTY,
} from "@/domains/activation/activation-test-fixtures";
import { useActivationUiStore } from "@/domains/activation/activation-ui-store";
import { getActivationList } from "@/domains/activation/catalog";
import type { ActivationProgress } from "@/domains/activation/hooks/use-activation-progress";
import { MIN_VERSION } from "@/lib/backwards-compat/use-supports-activation-progress";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useBannerVisibilityStore } from "@/stores/banner-visibility-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

let progress: ActivationProgress | undefined;

// Spread the real module: `mock.module` replaces it for every test file
// sharing this process, so returning only the mocked export would erase the
// rest for anything that loads it later.
const progressModule =
  await import("@/domains/activation/hooks/use-activation-progress");
// Captured by value: a module namespace's bindings are live, so reading the
// export back after the mock is installed would hand out the mock.
const { useActivationProgress: realUseActivationProgress } = progressModule;
mock.module("@/domains/activation/hooks/use-activation-progress", () => ({
  ...progressModule,
  useActivationProgress: () => ({ data: progress }),
}));

// The mock outlives this file otherwise, and the surfaces that read the same
// hook elsewhere (the Preferences entry point) would read this file's leftover
// snapshot instead of their own.
afterAll(() => {
  mock.module("@/domains/activation/hooks/use-activation-progress", () => ({
    ...progressModule,
    useActivationProgress: realUseActivationProgress,
  }));
});

/**
 * Telemetry is caught at its transport rather than at `emitActivationEvent`.
 * `mock.module` replaces a module for every test file sharing the process, and
 * `use-launch-activation-task.test.tsx` already claims
 * `@/utils/activation-telemetry`; taking the same module here would silently
 * erase its mock in a combined run.
 */
interface FunnelEvent {
  step_name?: string;
  screen?: string;
}

const events: FunnelEvent[] = [];
const ingestModule = await import("@/lib/telemetry/ingest");
mock.module("@/lib/telemetry/ingest", () => ({
  ...ingestModule,
  postTelemetryEvents: (posted: readonly object[]) => {
    events.push(...(posted as FunnelEvent[]));
  },
}));

const { ActivationController } =
  await import("@/domains/activation/activation-controller");
const { ActivationSuggestionsPillHost } =
  await import("@/domains/activation/activation-suggestions-pill-host");

const { starters } = getActivationList("smb");
const ASSISTANT_ID = "asst-1";

interface CapturedRequest {
  url: string;
  body: Record<string, unknown>;
}

const requests: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;
let dismissStatus = 200;

/** Records what the surfaces write, so a dismissal can be asserted on. */
function installFetch(): void {
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    let bodyText: string | undefined;
    if (input instanceof Request) {
      bodyText = await input.clone().text();
    } else if (typeof init?.body === "string") {
      bodyText = init.body;
    }
    requests.push({
      url,
      body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
    });
    const status = url.includes("/activation/dismiss") ? dismissStatus : 200;
    return new Response("{}", {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

/** The dismissals that reached `POST /v1/activation/dismiss`. */
function dismissals(): Record<string, unknown>[] {
  return requests
    .filter((request) => request.url.includes("/activation/dismiss"))
    .map((request) => request.body);
}

function renderSurfaces(): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/assistant/conversation/c1"]}>
        {children}
      </MemoryRouter>
    </QueryClientProvider>
  );
  return render(
    <>
      <ActivationSuggestionsPillHost />
      <ActivationController />
    </>,
    { wrapper },
  );
}

function setArm(arm: string): void {
  useClientFeatureFlagStore
    .getState()
    .setStringFlags({ activationChecklist: arm }, null);
}

beforeEach(() => {
  events.length = 0;
  requests.length = 0;
  dismissStatus = 200;
  installFetch();
  progress = ACTIVATION_PROGRESS_EMPTY;
  setArm("smb");
  useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
  useAssistantIdentityStore
    .getState()
    .setIdentity("Vel", MIN_VERSION, ASSISTANT_ID);
  useInChatOnboardingStore.setState({ prototypeActive: false });
  useBannerVisibilityStore.setState({ visibleBannerCount: 0 });
  useActivationUiStore.setState({
    expandedTaskId: null,
    showMore: false,
    modalReopened: false,
  });
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("ActivationController", () => {
  test("draws nothing when the flag arm is off", () => {
    setArm("off");
    const { container } = renderSurfaces();
    expect(container.textContent).toBe("");
  });

  test("draws nothing when the daemon predates the routes", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("Vel", "0.11.8", ASSISTANT_ID);
    const { container } = renderSurfaces();
    expect(container.textContent).toBe("");
  });

  test("draws nothing until progress has loaded", () => {
    progress = undefined;
    const { container } = renderSurfaces();
    expect(container.textContent).toBe("");
  });

  test("shows the welcome modal on a first visit", () => {
    const { getByRole } = renderSurfaces();
    expect(getByRole("button", { name: "Do it Later" })).not.toBeNull();
  });

  test("reports the modal once per opening, not once per render", () => {
    const { getByText } = renderSurfaces();
    // A render the modal is already open across: opening another row re-renders
    // the tree, and an event per render would multiply the funnel's first step.
    fireEvent.click(getByText(starters[1]!.title));
    expect(events.map((event) => [event.step_name, event.screen])).toEqual([
      ["activation_modal_shown", "smb"],
    ]);
  });

  test("Do it Later records the dismissal against the shown list", async () => {
    const { getByRole } = renderSurfaces();
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Do it Later" }));
    });
    expect(dismissals()).toEqual([{ kind: "modal", listId: "smb" }]);
  });

  test("closing the celebration records it as the celebration", async () => {
    progress = ACTIVATION_PROGRESS_ALL_DONE;
    const { getByRole } = renderSurfaces();
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Show me the full list" }));
    });
    expect(dismissals()).toEqual([{ kind: "all-done", listId: "smb" }]);
  });

  /**
   * The dialog is blocking and the write behind it is a round trip, so the
   * click has to take effect on the screen before the daemon hears about it.
   * `progress` is deliberately left unchanged here: it stands in for a read
   * that has not caught up, which is exactly the window the modal used to
   * stay open through.
   */
  test("Do it Later closes the modal without waiting for the write", () => {
    const { getByRole, queryByRole } = renderSurfaces();
    fireEvent.click(getByRole("button", { name: "Do it Later" }));
    expect(queryByRole("button", { name: "Do it Later" })).toBeNull();
  });

  test("a dismissal on one assistant does not silence the next assistant's welcome", async () => {
    const { getByRole, queryByRole } = renderSurfaces();
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Do it Later" }));
    });
    expect(queryByRole("button", { name: "Do it Later" })).toBeNull();

    await act(async () => {
      useResolvedAssistantsStore.setState({ activeAssistantId: "asst-2" });
      useAssistantIdentityStore
        .getState()
        .setIdentity("Vel", MIN_VERSION, "asst-2");
    });
    await waitFor(() => {
      expect(getByRole("button", { name: "Do it Later" })).toBeTruthy();
    });
  });

  test("a dismissal the daemon refused does not put the modal back", async () => {
    dismissStatus = 500;
    const { getByRole, queryByRole } = renderSurfaces();
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Do it Later" }));
    });
    expect(queryByRole("button", { name: "Do it Later" })).toBeNull();
  });

  test("closing the celebration closes it at once too", () => {
    progress = ACTIVATION_PROGRESS_ALL_DONE;
    const { getByRole, queryByRole } = renderSurfaces();
    fireEvent.click(getByRole("button", { name: "Show me the full list" }));
    expect(queryByRole("button", { name: "Show me the full list" })).toBeNull();
  });

  test("shows the celebration once every starter is done", () => {
    progress = ACTIVATION_PROGRESS_ALL_DONE;
    const { getByRole, queryByRole } = renderSurfaces();
    expect(
      getByRole("button", { name: "Show me the full list" }),
    ).not.toBeNull();
    expect(queryByRole("button", { name: "Do it Later" })).toBeNull();
  });
});

describe("ActivationSuggestionsPillHost", () => {
  test("shows the pill once the modal has been put off", () => {
    progress = ACTIVATION_PROGRESS_DISMISSED;
    const { getByRole } = renderSurfaces();
    expect(
      getByRole("button", { name: "Suggestions, 1 of 3 done" }),
    ).not.toBeNull();
  });

  test("hides the pill while the modal is the surface", () => {
    const { queryByRole } = renderSurfaces();
    expect(queryByRole("button", { name: /Suggestions/ })).toBeNull();
  });

  test("hides the pill once all three starters are done", () => {
    progress = {
      ...ACTIVATION_PROGRESS_ALL_DONE,
      modalDismissedAt: "2026-09-02T10:00:00.000Z",
      allDoneShownAt: "2026-09-02T10:05:00.000Z",
    };
    const { container } = renderSurfaces();
    expect(container.textContent).toBe("");
  });

  test("clicking the pill brings the modal back", () => {
    progress = ACTIVATION_PROGRESS_DISMISSED;
    const { getByRole } = renderSurfaces();
    fireEvent.click(getByRole("button", { name: "Suggestions, 1 of 3 done" }));
    expect(useActivationUiStore.getState().modalReopened).toBe(true);
    // The daemon already holds the dismissal; reopening must not rewrite it.
    expect(dismissals()).toEqual([]);
    expect(getByRole("button", { name: "Do it Later" })).not.toBeNull();
    expect(events.map((event) => event.step_name)).toEqual([
      "activation_pill_clicked",
      "activation_modal_shown",
    ]);
  });

  // A modal reopened from the pill closes locally and nothing else: the
  // dismissal it would write is one the daemon already holds.
  test("closing a reopened modal writes no second dismissal", () => {
    progress = ACTIVATION_PROGRESS_DISMISSED;
    const { getByRole, queryByRole } = renderSurfaces();
    fireEvent.click(getByRole("button", { name: "Suggestions, 1 of 3 done" }));
    fireEvent.click(getByRole("button", { name: "Do it Later" }));
    expect(queryByRole("button", { name: "Do it Later" })).toBeNull();
    expect(dismissals()).toEqual([]);
    expect(
      getByRole("button", { name: "Suggestions, 1 of 3 done" }),
    ).not.toBeNull();
  });
});
