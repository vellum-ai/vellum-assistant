/**
 * What the route owes the page: the right list, the daemon's progress, and the
 * two actions a row can take.
 *
 * The progress read, the launch and the capability signal are mocked at their
 * hook seams; each owns its own suite, and what is under test here is the
 * wiring between them.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import {
  ACTIVATION_PROGRESS_EMPTY,
  ACTIVATION_PROGRESS_LIST_MIXED,
  FIXTURE_STARTER_IDS,
} from "@/domains/activation/activation-test-fixtures";
import { getActivationList } from "@/domains/activation/catalog";
import type { ActivationProgress } from "@/domains/activation/hooks/use-activation-progress";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

let progress: ActivationProgress | undefined;
const launched: string[] = [];
const navigated: string[] = [];

// Every mock spreads the real module: `mock.module` replaces it for the whole
// test process, so returning only the overridden export would erase the rest
// for any file that loads it later.
const progressModule = await import(
  "@/domains/activation/hooks/use-activation-progress"
);
mock.module("@/domains/activation/hooks/use-activation-progress", () => ({
  ...progressModule,
  useActivationProgress: () => ({ data: progress }),
}));

const launchModule = await import(
  "@/domains/activation/hooks/use-launch-activation-task"
);
mock.module("@/domains/activation/hooks/use-launch-activation-task", () => ({
  ...launchModule,
  useLaunchActivationTask: () => ({
    launch: async (taskId: string) => {
      launched.push(taskId);
      return { ok: true };
    },
    pendingTaskId: null,
  }),
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

const { ActivationListRoute } = await import(
  "@/domains/activation/pages/activation-list-route"
);

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
}

function renderRoute() {
  return render(<ActivationListRoute />, { wrapper });
}

beforeEach(() => {
  progress = ACTIVATION_PROGRESS_EMPTY;
  setArm("smb");
  useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
});

afterEach(() => {
  cleanup();
  launched.length = 0;
  navigated.length = 0;
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
});
