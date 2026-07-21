/**
 * Exercises the real funnel pipeline (mocking only the generated ingest sdk
 * call, mirroring funnel-events.test.ts) so the payload mapping — screen =
 * tip id, step_name = action — and the consent gate are asserted end-to-end.
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
mock.module("@/generated/api/sdk.gen", () => ({
  telemetryIngestCreate: ingestMock,
}));

const { emitTipEvent } = await import("@/utils/tips-telemetry");

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

describe("emitTipEvent", () => {
  it("maps the tip id to screen and the action to step_name", () => {
    emitTipEvent("what-are-skills", "impression", "control");

    expect(ingestMock).toHaveBeenCalledTimes(1);
    expect(eventFromCall(0)).toMatchObject({
      type: "onboarding",
      screen: "what-are-skills",
      step_name: "impression",
      step_index: 0,
      funnel_version: "proactive-tips-v1",
      ab_variant: "control",
    });
  });

  it("gives each action a distinct step_name and index", () => {
    emitTipEvent("voice-mode", "impression", "control");
    emitTipEvent("voice-mode", "learn_more", "control");
    emitTipEvent("voice-mode", "dismiss", "control");
    emitTipEvent("voice-mode", "dont_show_again", "control");
    // Reserved action-tip vocabulary, unused by v1 info tips.
    emitTipEvent("voice-mode", "click", "control");
    emitTipEvent("voice-mode", "completion", "control");

    expect(ingestMock).toHaveBeenCalledTimes(6);
    expect(eventFromCall(0)).toMatchObject({
      step_name: "impression",
      step_index: 0,
    });
    expect(eventFromCall(1)).toMatchObject({
      step_name: "learn_more",
      step_index: 1,
    });
    expect(eventFromCall(2)).toMatchObject({
      step_name: "dismiss",
      step_index: 2,
    });
    expect(eventFromCall(3)).toMatchObject({
      step_name: "dont_show_again",
      step_index: 3,
    });
    expect(eventFromCall(4)).toMatchObject({
      step_name: "click",
      step_index: 4,
    });
    expect(eventFromCall(5)).toMatchObject({
      step_name: "completion",
      step_index: 5,
    });
  });

  it("stamps the caller's variant on every event", () => {
    emitTipEvent("app-builder", "dismiss", "pared_down");

    expect(eventFromCall(0)).toMatchObject({
      screen: "app-builder",
      ab_variant: "pared_down",
    });
  });

  it("does not emit when analytics sharing is opted out", () => {
    useOnboardingStore.setState({ shareAnalytics: false });

    emitTipEvent("what-are-skills", "impression", "control");

    expect(ingestMock).not.toHaveBeenCalled();
  });
});
