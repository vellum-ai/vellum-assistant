/**
 * Exercises the real funnel pipeline (mocking only the generated ingest sdk
 * call, mirroring tips-telemetry.test.ts) so the payload mapping (screen =
 * list id, ab_variant = flag arm, step_name = event) and the consent gate are
 * asserted end to end.
 *
 * The arm and the list are resolved by the emitter rather than passed in, so
 * they are driven here through the seams it reads: the flag store, and the
 * gate hook that publishes the list it resolved.
 */

import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { resetActivationFlagStore } from "@/domains/activation/activation-test-helpers";
import { activationProgressQueryKey } from "@/domains/activation/hooks/use-activation-progress";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { useEffectiveActivationListId } from "@/hooks/use-activation-enabled";
import { MIN_VERSION } from "@/lib/backwards-compat/use-supports-activation-progress";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const ingestMock = mock(
  async (_options: { body: unknown; keepalive?: boolean }) => ({
    data: { accepted: 1, persisted: 1, dropped: {} },
    error: undefined,
    response: { ok: true, status: 200 } as Response,
  }),
);
// Spread the real module: `mock.module` replaces the whole module for every
// test file sharing this process, so returning only the mocked export erases
// the rest of the generated sdk for anything that loads it later.
const sdk = await import("@/generated/api/sdk.gen");
mock.module("@/generated/api/sdk.gen", () => ({
  ...sdk,
  telemetryIngestCreate: ingestMock,
}));

const { emitActivationEvent } = await import("@/utils/activation-telemetry");

const ASSISTANT_ID = "asst-1";

function eventFromCall(callIndex: number): Record<string, unknown> {
  const options = ingestMock.mock.calls[callIndex]?.[0] as
    | { body: { events: Array<Record<string, unknown>> } }
    | undefined;
  if (!options) {
    throw new Error(`No ingest call at index ${callIndex}`);
  }
  return options.body.events[0] ?? {};
}

/**
 * Put the client on `arm` and let the gate hook publish whatever list that
 * resolves to, optionally with a list the daemon has already frozen.
 */
function resolveList(arm: string, frozenListId?: string | null): void {
  useClientFeatureFlagStore
    .getState()
    .setStringFlags({ activationChecklist: arm }, null);
  useClientFeatureFlagStore.setState({ hydrated: true });
  useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });
  useAssistantIdentityStore
    .getState()
    .setIdentity("Vel", MIN_VERSION, ASSISTANT_ID);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (frozenListId !== undefined) {
    queryClient.setQueryData(activationProgressQueryKey(ASSISTANT_ID), {
      version: 1,
      listId: frozenListId,
      modalDismissedAt: null,
      allDoneShownAt: null,
      tasks: {},
    });
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  renderHook(() => useEffectiveActivationListId(), { wrapper });
}

// The opt-out below is stored consent, which every later suite's emitter
// reads: leaving it off silences telemetry for the rest of the process.
afterAll(() => {
  useOnboardingStore.setState({ shareAnalytics: true });
  resetActivationFlagStore();
});

beforeEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  useOnboardingStore.setState({ shareAnalytics: true });
  ingestMock.mockClear();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("emitActivationEvent", () => {
  it("stamps the funnel version, the list id and the flag arm", () => {
    resolveList("smb");
    emitActivationEvent("activation_modal_shown");

    expect(ingestMock).toHaveBeenCalledTimes(1);
    expect(eventFromCall(0)).toMatchObject({
      type: "onboarding",
      screen: "smb",
      step_name: "activation_modal_shown",
      step_index: 0,
      funnel_version: "activation_checklist_v1_2026_09",
      ab_variant: "smb",
    });
  });

  it("qualifies a task-scoped event with the task id", () => {
    resolveList("parent");
    emitActivationEvent("activation_task_started", { taskId: "meal-planner" });

    expect(eventFromCall(0)).toMatchObject({
      screen: "parent/meal-planner",
      step_name: "activation_task_started",
      step_index: 1,
      ab_variant: "parent",
    });
  });

  // Closing the celebration retires the checklist and closing the welcome
  // modal only defers it, so the funnel has to be able to tell them apart.
  it("qualifies a dismissal with the surface that was closed", () => {
    resolveList("smb");
    emitActivationEvent("activation_modal_dismissed", { kind: "all-done" });

    expect(eventFromCall(0)).toMatchObject({
      screen: "smb/all-done",
      step_name: "activation_modal_dismissed",
      step_index: 3,
    });
  });

  // Re-bucketing a user in LaunchDarkly must not refile their funnel under a
  // list they were never shown.
  it("reports the frozen list rather than the arm's", () => {
    resolveList("parent", "smb");
    emitActivationEvent("activation_list_opened");

    expect(eventFromCall(0)).toMatchObject({
      screen: "smb",
      ab_variant: "parent",
    });
  });

  it("reports an unresolved list as unknown rather than dropping the event", () => {
    resolveList("off");
    emitActivationEvent("activation_pill_clicked");

    expect(eventFromCall(0)).toMatchObject({
      screen: "unknown",
      ab_variant: "off",
    });
  });

  it("gives each event a distinct step name and index", () => {
    resolveList("smb");
    emitActivationEvent("activation_modal_shown");
    emitActivationEvent("activation_task_started");
    emitActivationEvent("activation_task_completed");
    emitActivationEvent("activation_modal_dismissed");
    emitActivationEvent("activation_pill_clicked");
    emitActivationEvent("activation_list_opened");

    expect(ingestMock).toHaveBeenCalledTimes(6);
    const seen = [0, 1, 2, 3, 4, 5].map((index) => eventFromCall(index));
    expect(seen.map((event) => event.step_name)).toEqual([
      "activation_modal_shown",
      "activation_task_started",
      "activation_task_completed",
      "activation_modal_dismissed",
      "activation_pill_clicked",
      "activation_list_opened",
    ]);
    expect(seen.map((event) => event.step_index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("does not emit when analytics sharing is opted out", () => {
    resolveList("smb");
    useOnboardingStore.setState({ shareAnalytics: false });

    emitActivationEvent("activation_modal_shown");

    expect(ingestMock).not.toHaveBeenCalled();
  });
});
