/**
 * What the route owes the page: the right list, the daemon's progress, the
 * gates that decide whether the page may render at all, and the two actions a
 * row can take, including what a failed one says.
 *
 * The progress read, the launch, the toast and conversation navigation are
 * mocked at their seams; each owns its own suite, and what is under test here
 * is the wiring between them. The version gate is not mocked: it reads the
 * identity store, which is the thing a bookmark against an old assistant
 * actually trips.
 *
 * Every mock spreads the real module and is put back in `afterAll`, because
 * `mock.module` replaces a module for the whole test process: a mock that
 * drops the other exports breaks whatever loads the module next, and one that
 * is never restored outlives the file that installed it.
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
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";

import {
  ACTIVATION_PROGRESS_EMPTY,
  ACTIVATION_PROGRESS_LIST_MIXED,
  FIXTURE_STARTER_IDS,
} from "@/domains/activation/activation-test-fixtures";
import {
  mockActivationProgress,
  resetActivationFlagStore,
  seedActivationIdentity,
  setActivationArm,
} from "@/domains/activation/activation-test-helpers";
import { getActivationList } from "@/domains/activation/catalog";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { routes } from "@/utils/routes";

interface LaunchOutcome {
  ok: boolean;
  conversationId?: string;
  error?: string;
}

interface CapturedToast {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

let launchOutcome: LaunchOutcome = { ok: true };
const launched: string[] = [];
const navigated: string[] = [];
const toasts: CapturedToast[] = [];

const progressMock = await mockActivationProgress();

// Each real export is captured by value before the mock goes in: a module
// namespace's bindings are live, so reading one back afterwards would hand out
// the mock rather than the original.
const launchModule =
  await import("@/domains/activation/hooks/use-launch-activation-task");
const { useLaunchActivationTask: realUseLaunchActivationTask } = launchModule;
mock.module("@/domains/activation/hooks/use-launch-activation-task", () => ({
  ...launchModule,
  useLaunchActivationTask: () => ({
    launch: async (taskId: string) => {
      launched.push(taskId);
      return launchOutcome;
    },
    pendingTaskIds: new Set<string>(),
  }),
}));

const toastModule = await import("@vellumai/design-library/components/toast");
const { toast: realToast } = toastModule;
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: {
    ...realToast,
    error: (
      message: string,
      options?: { action?: { label: string; onClick: () => void } },
    ) => {
      toasts.push({
        message,
        actionLabel: options?.action?.label,
        onAction: options?.action?.onClick,
      });
    },
  },
}));

const navigationModule = await import("@/utils/conversation-navigation");
const { navigateToConversation: realNavigateToConversation } = navigationModule;
mock.module("@/utils/conversation-navigation", () => ({
  ...navigationModule,
  navigateToConversation: (_navigate: unknown, conversationId: string) => {
    navigated.push(conversationId);
  },
}));

afterAll(() => {
  progressMock.restore();
  mock.module("@/domains/activation/hooks/use-launch-activation-task", () => ({
    ...launchModule,
    useLaunchActivationTask: realUseLaunchActivationTask,
  }));
  mock.module("@vellumai/design-library/components/toast", () => ({
    ...toastModule,
    toast: realToast,
  }));
  mock.module("@/utils/conversation-navigation", () => ({
    ...navigationModule,
    navigateToConversation: realNavigateToConversation,
  }));
});

const { ActivationListRoute } =
  await import("@/domains/activation/pages/activation-list-route");

const { starters } = getActivationList("smb");

function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter initialEntries={[routes.activationList]}>
      {children}
    </MemoryRouter>
  );
}

function renderRoute() {
  return render(<ActivationListRoute />, { wrapper });
}

beforeEach(() => {
  progressMock.set(ACTIVATION_PROGRESS_EMPTY);
  launchOutcome = { ok: true };
  setActivationArm("smb");
  seedActivationIdentity("asst-1");
});

afterEach(() => {
  cleanup();
  resetActivationFlagStore();
  useAssistantIdentityStore.getState().clearIdentity();
  launched.length = 0;
  navigated.length = 0;
  toasts.length = 0;
});

describe("ActivationListRoute", () => {
  test("renders the arm's list", () => {
    renderRoute();

    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(3);
    expect(screen.getByText(starters[0]?.title ?? "")).toBeTruthy();
  });

  test("an arm that names no list hands the user back to chat", () => {
    setActivationArm("off");
    renderRoute();

    expect(screen.queryByRole("listitem")).toBeNull();
  });

  test("the daemon's frozen list wins over the arm", () => {
    // A re-bucketed user keeps the checklist they started, the same rule the
    // modal and the pill follow.
    setActivationArm("parent");
    progressMock.set(ACTIVATION_PROGRESS_LIST_MIXED);
    renderRoute();

    expect(screen.getByText(starters[0]?.title ?? "")).toBeTruthy();
  });

  test("an untouched row launches its task", () => {
    renderRoute();

    fireEvent.click(
      screen.getByText(starters[0]?.title ?? "").closest("button")!,
    );

    expect(launched).toEqual([FIXTURE_STARTER_IDS[0]]);
    expect(navigated).toEqual([]);
  });

  test("a finished row opens the conversation it ran in", () => {
    progressMock.set(ACTIVATION_PROGRESS_LIST_MIXED);
    renderRoute();

    fireEvent.click(
      screen.getByText(starters[0]?.title ?? "").closest("button")!,
    );

    expect(navigated).toEqual(["conv-done-1"]);
    expect(launched).toEqual([]);
  });

  // A bookmark reaches this page directly, and an assistant without the
  // `/v1/activation/*` routes can neither answer the progress read nor link a
  // launch, so every row would offer work it cannot do.
  test("an assistant below the activation floor hands the user back to chat", () => {
    seedActivationIdentity("asst-1", "0.11.0");
    progressMock.set(ACTIVATION_PROGRESS_LIST_MIXED);
    renderRoute();

    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.queryByText(starters[0]?.title ?? "")).toBeNull();
  });
});

describe("ActivationListRoute before progress lands", () => {
  // An absent record reads as "never started", so a finished task rendered
  // against a progress read still in flight would offer to run again.
  test("no task can launch until the daemon has answered", () => {
    progressMock.set(undefined);
    const { rerender } = renderRoute();

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText(starters[0]?.title ?? "")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();

    // The answer arrives, carrying a task that is already done.
    progressMock.set(ACTIVATION_PROGRESS_LIST_MIXED);
    rerender(<ActivationListRoute />);

    fireEvent.click(
      screen.getByText(starters[0]?.title ?? "").closest("button")!,
    );

    expect(launched).toEqual([]);
    expect(navigated).toEqual(["conv-done-1"]);
  });
});

describe("ActivationListRoute launch failures", () => {
  test("a refused launch says so", async () => {
    launchOutcome = { ok: false, error: "no conversation for you" };
    renderRoute();

    fireEvent.click(
      screen.getByText(starters[0]?.title ?? "").closest("button")!,
    );

    await waitFor(() => {
      expect(toasts).toHaveLength(1);
    });
    expect(toasts[0]?.message).toBe("no conversation for you");
    // Nothing was linked, so there is nothing to recover into.
    expect(toasts[0]?.actionLabel).toBeUndefined();
  });

  // A send that fails after the link stands leaves a real conversation the
  // task owns; the user has to be able to reach it.
  test("a failed send offers the conversation it already linked", async () => {
    launchOutcome = {
      ok: false,
      conversationId: "conv-linked-1",
      error: "daemon said no",
    };
    renderRoute();

    fireEvent.click(
      screen.getByText(starters[0]?.title ?? "").closest("button")!,
    );

    await waitFor(() => {
      expect(toasts).toHaveLength(1);
    });
    expect(toasts[0]?.message).toBe("daemon said no");
    expect(toasts[0]?.actionLabel).toBe("Open conversation");

    toasts[0]?.onAction?.();
    expect(navigated).toEqual(["conv-linked-1"]);
  });

  // A launch refused because the same task is already running is not a failure
  // the user caused, and it carries nothing to say.
  test("a launch with nothing to report shows no toast", async () => {
    launchOutcome = { ok: false };
    renderRoute();

    fireEvent.click(
      screen.getByText(starters[0]?.title ?? "").closest("button")!,
    );

    await waitFor(() => {
      expect(launched).toEqual([FIXTURE_STARTER_IDS[0]]);
    });
    expect(toasts).toEqual([]);
  });
});

/**
 * A cold load has neither the flag values nor the assistant's version in hand,
 * and both read as "off" until they land. The route must not spend that window
 * redirecting: this page is reached by a bookmark, a reload and a fresh tab.
 */
describe("ActivationListRoute before the gates settle", () => {
  function PathProbe(): ReactNode {
    const { pathname } = useLocation();
    return <div data-testid="pathname">{pathname}</div>;
  }

  function renderWithPath() {
    return render(
      <>
        <ActivationListRoute />
        <PathProbe />
      </>,
      { wrapper },
    );
  }

  test("stays put while the assistant's version is unknown", () => {
    useAssistantIdentityStore.getState().clearIdentity();
    renderWithPath();

    expect(screen.getByTestId("pathname").textContent).toBe(
      routes.activationList,
    );
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  // A gate that has said no has settled the question. Waiting on the other one
  // for a second opinion it cannot change is how an arm switched off leaves a
  // bookmark on a page that renders nothing at all.
  test("hands the user back to chat on an arm that is off, whatever the version is doing", () => {
    setActivationArm("off");
    useAssistantIdentityStore.getState().clearIdentity();
    renderWithPath();

    expect(screen.getByTestId("pathname").textContent).toBe(routes.assistant);
  });

  // `fetchAssistantIdentity` turns an unreachable runtime into a successful
  // `null`, so the version never lands and never will. The wait has to end on
  // the fetch settling, not on a version that is not coming.
  test("hands the user back to chat once the identity fetch has given up", () => {
    useAssistantIdentityStore.getState().clearIdentity();
    useAssistantIdentityStore.getState().markIdentityUnavailable("asst-1");
    renderWithPath();

    expect(screen.getByTestId("pathname").textContent).toBe(routes.assistant);
  });

  // The dead end is scoped like the version it stands in for: one recorded for
  // the assistant the user just left says nothing about this one.
  test("stays put when another assistant's identity fetch gave up", () => {
    useAssistantIdentityStore.getState().clearIdentity();
    useAssistantIdentityStore.getState().markIdentityUnavailable("asst-other");
    renderWithPath();

    expect(screen.getByTestId("pathname").textContent).toBe(
      routes.activationList,
    );
  });

  test("stays put while the flag values are still in flight", () => {
    useClientFeatureFlagStore.setState({ hydrated: false });
    renderWithPath();

    expect(screen.getByTestId("pathname").textContent).toBe(
      routes.activationList,
    );
  });

  test("hands the user back to chat once the gates have answered", () => {
    setActivationArm("off");
    renderWithPath();

    expect(screen.getByTestId("pathname").textContent).toBe(routes.assistant);
  });
});
