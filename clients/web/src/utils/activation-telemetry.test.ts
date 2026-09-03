/**
 * Exercises the real funnel pipeline (mocking only the generated ingest sdk
 * call, mirroring tips-telemetry.test.ts) so the payload mapping (screen =
 * list id, ab_variant = flag arm, step_name = event) and the consent gate are
 * asserted end to end.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";

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

function eventFromCall(callIndex: number): Record<string, unknown> {
  const options = ingestMock.mock.calls[callIndex]?.[0] as
    | { body: { events: Array<Record<string, unknown>> } }
    | undefined;
  if (!options) {
    throw new Error(`No ingest call at index ${callIndex}`);
  }
  return options.body.events[0] ?? {};
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  useOnboardingStore.setState({ shareAnalytics: true });
  ingestMock.mockClear();
});

describe("emitActivationEvent", () => {
  it("stamps the funnel version, the list id and the flag arm", () => {
    emitActivationEvent("activation_modal_shown", {
      arm: "smb",
      listId: "smb",
    });

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
    emitActivationEvent("activation_task_started", {
      arm: "parent",
      listId: "parent",
      taskId: "meal-planner",
    });

    expect(eventFromCall(0)).toMatchObject({
      screen: "parent/meal-planner",
      step_name: "activation_task_started",
      step_index: 1,
      ab_variant: "parent",
    });
  });

  it("reports an unfrozen list as unknown rather than dropping the event", () => {
    emitActivationEvent("activation_pill_clicked", {
      arm: "general",
      listId: null,
    });

    expect(eventFromCall(0)).toMatchObject({
      screen: "unknown",
      ab_variant: "general",
    });
  });

  it("gives each event a distinct step name and index", () => {
    const context = { arm: "smb", listId: "smb" };
    emitActivationEvent("activation_modal_shown", context);
    emitActivationEvent("activation_task_started", context);
    emitActivationEvent("activation_task_completed", context);
    emitActivationEvent("activation_modal_dismissed", context);
    emitActivationEvent("activation_pill_clicked", context);
    emitActivationEvent("activation_list_opened", context);

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
    useOnboardingStore.setState({ shareAnalytics: false });

    emitActivationEvent("activation_modal_shown", {
      arm: "smb",
      listId: "smb",
    });

    expect(ingestMock).not.toHaveBeenCalled();
  });
});
