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
  doneTaskProgress,
} from "@/domains/activation/activation-test-fixtures";
import {
  installActivationFetchStub,
  mockActivationProgress,
  resetActivationFlagStore,
  seedActivationIdentity,
  setActivationArm,
  type ActivationFetchStub,
} from "@/domains/activation/activation-test-helpers";
import { useActivationUiStore } from "@/domains/activation/activation-ui-store";
import { getActivationList } from "@/domains/activation/catalog";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useBannerVisibilityStore } from "@/stores/banner-visibility-store";
import { useInChatOnboardingStore } from "@/stores/in-chat-onboarding-store";

const progressMock = await mockActivationProgress();

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
// Captured by value: a module namespace's bindings are live, so reading the
// export back after the mock is installed would hand out the mock.
const { postTelemetryEvents: realPostTelemetryEvents } = ingestModule;
mock.module("@/lib/telemetry/ingest", () => ({
  ...ingestModule,
  postTelemetryEvents: (posted: readonly object[]) => {
    events.push(...(posted as FunnelEvent[]));
  },
}));

// Both mocks outlive this file otherwise, and the surfaces that read the same
// modules elsewhere would read this file's leftovers instead of their own.
afterAll(() => {
  progressMock.restore();
  mock.module("@/lib/telemetry/ingest", () => ({
    ...ingestModule,
    postTelemetryEvents: realPostTelemetryEvents,
  }));
});

const { ActivationController } =
  await import("@/domains/activation/activation-controller");
const { ActivationSuggestionsPillHost } =
  await import("@/domains/activation/activation-suggestions-pill-host");

const { starters } = getActivationList("smb");
const ASSISTANT_ID = "asst-1";

let fetchStub: ActivationFetchStub;

/** The dismissals that reached `POST /v1/activation/dismiss`. */
function dismissals(): Record<string, unknown>[] {
  return fetchStub
    .matching("/activation/dismiss")
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

beforeEach(() => {
  events.length = 0;
  fetchStub = installActivationFetchStub();
  progressMock.set(ACTIVATION_PROGRESS_EMPTY);
  setActivationArm("smb");
  seedActivationIdentity(ASSISTANT_ID);
  useInChatOnboardingStore.setState({ prototypeActive: false });
  useBannerVisibilityStore.setState({ visibleBannerCount: 0 });
  useActivationUiStore.getState().resetTransientState();
});

afterEach(() => {
  cleanup();
  resetActivationFlagStore();
  fetchStub.restore();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("ActivationController", () => {
  test("draws nothing when the flag arm is off", () => {
    setActivationArm("off");
    const { container } = renderSurfaces();
    expect(container.textContent).toBe("");
  });

  test("draws nothing when the daemon predates the routes", () => {
    seedActivationIdentity(ASSISTANT_ID, "0.11.8");
    const { container } = renderSurfaces();
    expect(container.textContent).toBe("");
  });

  test("draws nothing until progress has loaded", () => {
    progressMock.set(undefined);
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
    progressMock.set(ACTIVATION_PROGRESS_ALL_DONE);
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
      seedActivationIdentity("asst-2");
    });
    await waitFor(() => {
      expect(getByRole("button", { name: "Do it Later" })).toBeTruthy();
    });
  });

  test("switching assistants drops the previous checklist's transient choices", async () => {
    renderSurfaces();
    act(() => {
      useActivationUiStore.setState({ showMore: true, expandedTaskId: "x" });
    });
    await act(async () => {
      seedActivationIdentity("asst-2");
    });
    expect(useActivationUiStore.getState().showMore).toBe(false);
    expect(useActivationUiStore.getState().expandedTaskId).toBeNull();
  });

  test("a dismissal the daemon refused does not put the modal back", async () => {
    fetchStub.statuses["/activation/dismiss"] = 500;
    const { getByRole, queryByRole } = renderSurfaces();
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Do it Later" }));
    });
    expect(queryByRole("button", { name: "Do it Later" })).toBeNull();
  });

  test("closing the celebration closes it at once too", () => {
    progressMock.set(ACTIVATION_PROGRESS_ALL_DONE);
    const { getByRole, queryByRole } = renderSurfaces();
    fireEvent.click(getByRole("button", { name: "Show me the full list" }));
    expect(queryByRole("button", { name: "Show me the full list" })).toBeNull();
  });

  test("shows the celebration once every starter is done", () => {
    progressMock.set(ACTIVATION_PROGRESS_ALL_DONE);
    const { getByRole, queryByRole } = renderSurfaces();
    expect(
      getByRole("button", { name: "Show me the full list" }),
    ).not.toBeNull();
    expect(queryByRole("button", { name: "Do it Later" })).toBeNull();
  });
});

/**
 * The daemon owns whether a task is done and nothing else in the funnel is
 * daemon-side, so the completion step is observed here, where the rest of the
 * funnel is emitted.
 */
describe("activation completion telemetry", () => {
  test("reports a task the daemon finishes while the session is open", () => {
    const { rerender } = renderSurfaces();
    expect(events.map((event) => event.step_name)).toEqual([
      "activation_modal_shown",
    ]);

    act(() => {
      progressMock.set({
        ...ACTIVATION_PROGRESS_EMPTY,
        tasks: { [starters[0]!.id]: doneTaskProgress() },
      });
    });
    rerender(
      <>
        <ActivationSuggestionsPillHost />
        <ActivationController />
      </>,
    );

    const completions = events.filter(
      (event) => event.step_name === "activation_task_completed",
    );
    expect(completions.map((event) => event.screen)).toEqual([
      `smb/${starters[0]!.id}`,
    ]);
  });

  // A reload after finishing a task must not re-report it: the first snapshot
  // a session sees is the baseline, not a transition.
  test("reports nothing for a task already done when the session opened", () => {
    progressMock.set(ACTIVATION_PROGRESS_DISMISSED);
    renderSurfaces();

    expect(
      events.filter((event) => event.step_name === "activation_task_completed"),
    ).toEqual([]);
  });
});

describe("ActivationSuggestionsPillHost", () => {
  test("shows the pill once the modal has been put off", () => {
    progressMock.set(ACTIVATION_PROGRESS_DISMISSED);
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
    progressMock.set({
      ...ACTIVATION_PROGRESS_ALL_DONE,
      modalDismissedAt: "2026-09-02T10:00:00.000Z",
      allDoneShownAt: "2026-09-02T10:05:00.000Z",
    });
    const { container } = renderSurfaces();
    expect(container.textContent).toBe("");
  });

  test("clicking the pill brings the modal back", () => {
    progressMock.set(ACTIVATION_PROGRESS_DISMISSED);
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
    progressMock.set(ACTIVATION_PROGRESS_DISMISSED);
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
