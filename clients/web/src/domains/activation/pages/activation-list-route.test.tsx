/**
 * What the route owes the page: the right list, the daemon's progress, the
 * gates that decide whether the page may render at all, and the two actions a
 * row can take, including what a failed one says.
 *
 * The progress read, the launch, the capability signal and the toast are
 * mocked at their seams; each owns its own suite, and what is under test here
 * is the wiring between them. The version gate is not mocked: it reads the
 * identity store, which is the thing a bookmark against an old assistant
 * actually trips.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
import { getActivationList } from "@/domains/activation/catalog";
import type { ActivationProgress } from "@/domains/activation/hooks/use-activation-progress";
import { MIN_VERSION } from "@/lib/backwards-compat/use-supports-activation-progress";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
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

let progress: ActivationProgress | undefined;
let launchOutcome: LaunchOutcome = { ok: true };
const launched: string[] = [];
const navigated: string[] = [];
const toasts: CapturedToast[] = [];

// Every mock spreads the real module: `mock.module` replaces it for the whole
// test process, so returning only the overridden export would erase the rest
// for any file that loads it later.
const progressModule =
  await import("@/domains/activation/hooks/use-activation-progress");
mock.module("@/domains/activation/hooks/use-activation-progress", () => ({
  ...progressModule,
  useActivationProgress: () => ({ data: progress }),
}));

const launchModule =
  await import("@/domains/activation/hooks/use-launch-activation-task");
mock.module("@/domains/activation/hooks/use-launch-activation-task", () => ({
  ...launchModule,
  useLaunchActivationTask: () => ({
    launch: async (taskId: string) => {
      launched.push(taskId);
      return launchOutcome;
    },
    pendingTaskIds: new Set<string>(),
    isPending: () => false,
  }),
}));

const toastModule = await import("@vellumai/design-library/components/toast");
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: {
    ...toastModule.toast,
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

const capabilitiesModule = await import("@/domains/activation/capabilities");
mock.module("@/domains/activation/capabilities", () => ({
  ...capabilitiesModule,
  useAvailableCapabilityTags: () =>
    new Set(capabilitiesModule.ACTIVATION_CAPABILITY_TAGS),
}));

const navigationModule = await import("@/utils/conversation-navigation");
mock.module("@/utils/conversation-navigation", () => ({
  ...navigationModule,
  navigateToConversation: (_navigate: unknown, conversationId: string) => {
    navigated.push(conversationId);
  },
}));

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

function setArm(arm: string): void {
  useClientFeatureFlagStore
    .getState()
    .setStringFlags({ activationChecklist: arm }, null);
  // The values a server response carries, and the fact that one has landed,
  // are two writes on this store; the route waits for the second before it
  // acts on the first.
  useClientFeatureFlagStore.setState({ hydrated: true });
}

function renderRoute() {
  return render(<ActivationListRoute />, { wrapper });
}

beforeEach(() => {
  progress = ACTIVATION_PROGRESS_EMPTY;
  launchOutcome = { ok: true };
  setArm("smb");
  useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
  useAssistantIdentityStore
    .getState()
    .setIdentity("Vel", MIN_VERSION, "asst-1");
});

afterEach(() => {
  cleanup();
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
    setArm("off");
    renderRoute();

    expect(screen.queryByRole("listitem")).toBeNull();
  });

  test("the daemon's frozen list wins over the arm", () => {
    // A re-bucketed user keeps the checklist they started, the same rule the
    // modal and the pill follow.
    setArm("parent");
    progress = ACTIVATION_PROGRESS_LIST_MIXED;
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
    progress = ACTIVATION_PROGRESS_LIST_MIXED;
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
    useAssistantIdentityStore.getState().setIdentity("Vel", "0.11.0", "asst-1");
    progress = ACTIVATION_PROGRESS_LIST_MIXED;
    renderRoute();

    expect(screen.queryByRole("listitem")).toBeNull();
    expect(screen.queryByText(starters[0]?.title ?? "")).toBeNull();
  });
});

describe("ActivationListRoute before progress lands", () => {
  // An absent record reads as "never started", so a finished task rendered
  // against a progress read still in flight would offer to run again.
  test("no task can launch until the daemon has answered", () => {
    progress = undefined;
    const { rerender } = renderRoute();

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByText(starters[0]?.title ?? "")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();

    // The answer arrives, carrying a task that is already done.
    progress = ACTIVATION_PROGRESS_LIST_MIXED;
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

  test("stays put while the flag values are still in flight", () => {
    useClientFeatureFlagStore.setState({ hydrated: false });
    renderWithPath();

    expect(screen.getByTestId("pathname").textContent).toBe(
      routes.activationList,
    );
  });

  test("hands the user back to chat once the gates have answered", () => {
    setArm("off");
    renderWithPath();

    expect(screen.getByTestId("pathname").textContent).toBe(routes.assistant);
  });
});
