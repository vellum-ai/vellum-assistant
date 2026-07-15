/**
 * Exercises the real funnel pipeline (fetch-level mock rather than
 * `mock.module`, which is process-global) so the payload mapping — screen =
 * tip id, step_name = action — and the consent gate are asserted end-to-end.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { emitTipEvent } from "@/utils/tips-telemetry";

const originalFetch = globalThis.fetch;

function installFetchMock() {
  const fetchMock = mock(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("{}", { status: 200 }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function eventFromCall(
  fetchMock: ReturnType<typeof installFetchMock>,
  callIndex: number,
): Record<string, unknown> {
  const calls = fetchMock.mock.calls as Array<
    [RequestInfo | URL, RequestInit | undefined]
  >;
  const payload = JSON.parse(calls[callIndex]?.[1]?.body as string) as {
    events: Array<Record<string, unknown>>;
  };
  return payload.events[0] ?? {};
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  localStorage.setItem("device:share_analytics", "true");
  useOnboardingStore.setState({ shareAnalytics: true });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("emitTipEvent", () => {
  it("maps the tip id to screen and the action to step_name", () => {
    const fetchMock = installFetchMock();

    emitTipEvent("what-are-skills", "impression", "control");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as Array<
      [RequestInfo | URL, RequestInit | undefined]
    >;
    expect(calls[0]?.[0]).toBe("/v1/telemetry/ingest/");
    expect(eventFromCall(fetchMock, 0)).toMatchObject({
      type: "onboarding",
      screen: "what-are-skills",
      step_name: "impression",
      step_index: 0,
      funnel_version: "proactive-tips-v1",
      ab_variant: "control",
    });
  });

  it("gives each action a distinct step_name and index", () => {
    const fetchMock = installFetchMock();

    emitTipEvent("voice-mode", "impression", "control");
    emitTipEvent("voice-mode", "learn_more", "control");
    emitTipEvent("voice-mode", "dismiss", "control");
    emitTipEvent("voice-mode", "dont_show_again", "control");
    // Reserved action-tip vocabulary, unused by v1 info tips.
    emitTipEvent("voice-mode", "click", "control");
    emitTipEvent("voice-mode", "completion", "control");

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(eventFromCall(fetchMock, 0)).toMatchObject({
      step_name: "impression",
      step_index: 0,
    });
    expect(eventFromCall(fetchMock, 1)).toMatchObject({
      step_name: "learn_more",
      step_index: 1,
    });
    expect(eventFromCall(fetchMock, 2)).toMatchObject({
      step_name: "dismiss",
      step_index: 2,
    });
    expect(eventFromCall(fetchMock, 3)).toMatchObject({
      step_name: "dont_show_again",
      step_index: 3,
    });
    expect(eventFromCall(fetchMock, 4)).toMatchObject({
      step_name: "click",
      step_index: 4,
    });
    expect(eventFromCall(fetchMock, 5)).toMatchObject({
      step_name: "completion",
      step_index: 5,
    });
  });

  it("stamps the caller's variant on every event", () => {
    const fetchMock = installFetchMock();

    emitTipEvent("app-builder", "dismiss", "pared_down");

    expect(eventFromCall(fetchMock, 0)).toMatchObject({
      screen: "app-builder",
      ab_variant: "pared_down",
    });
  });

  it("does not emit when analytics sharing is opted out", () => {
    useOnboardingStore.setState({ shareAnalytics: false });
    const fetchMock = installFetchMock();

    emitTipEvent("what-are-skills", "impression", "control");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
