import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  __resetOnboardingFunnelEventsForTests,
  buildOnboardingFunnelEvent,
  emitOnboardingFunnelStepCompleted,
  ONBOARDING_FUNNEL_STEPS,
  ONBOARDING_FUNNEL_VERSION,
} from "@/domains/onboarding/funnel-events";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  __resetOnboardingFunnelEventsForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("onboarding funnel events", () => {
  test("builds the expected event shape with a stable session id", () => {
    const privacy = buildOnboardingFunnelEvent(
      ONBOARDING_FUNNEL_STEPS.privacyTos,
      { userId: "user-123" },
    );
    const nameVibe = buildOnboardingFunnelEvent(
      ONBOARDING_FUNNEL_STEPS.nameVibe,
      { userId: "user-123" },
    );

    expect(privacy.session_id).toBeTruthy();
    expect(nameVibe.session_id).toBe(privacy.session_id);
    expect(privacy).toMatchObject({
      type: "onboarding",
      screen: "privacy_tos",
      step_name: "privacy_tos",
      step_index: 0,
      user_id: "user-123",
      funnel_version: ONBOARDING_FUNNEL_VERSION,
    });
    expect(nameVibe).toMatchObject({
      screen: "name_vibe",
      step_name: "name_vibe",
      step_index: 1,
      user_id: "user-123",
      funnel_version: ONBOARDING_FUNNEL_VERSION,
    });
    expect(privacy.completed_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  test("emits fire-and-forget telemetry payloads with the same session id", () => {
    const fetchMock = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("{}", { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    emitOnboardingFunnelStepCompleted(ONBOARDING_FUNNEL_STEPS.privacyTos, {
      userId: "user-123",
    });
    emitOnboardingFunnelStepCompleted(ONBOARDING_FUNNEL_STEPS.gmailConnect, {
      userId: "user-123",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as Array<
      [RequestInfo | URL, RequestInit | undefined]
    >;
    const firstPayload = JSON.parse(
      calls[0]?.[1]?.body as string,
    ) as { events: Array<Record<string, unknown>> };
    const secondPayload = JSON.parse(
      calls[1]?.[1]?.body as string,
    ) as { events: Array<Record<string, unknown>> };
    const firstEvent = firstPayload.events[0];
    const secondEvent = secondPayload.events[0];

    expect(calls[0]?.[0]).toBe("/v1/telemetry/ingest/");
    expect(firstEvent?.session_id).toBeTruthy();
    expect(secondEvent?.session_id).toBe(firstEvent?.session_id);
    expect(secondEvent).toMatchObject({
      screen: "gmail_connect",
      step_name: "gmail_connect",
      step_index: 2,
      user_id: "user-123",
      funnel_version: ONBOARDING_FUNNEL_VERSION,
    });
  });
});
