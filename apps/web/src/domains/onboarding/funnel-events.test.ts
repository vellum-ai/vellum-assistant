import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  __resetOnboardingFunnelEventsForTests,
  buildOnboardingFunnelEvent,
  emitOnboardingFunnelStepCompleted,
  onboardingFunnelVariantFromExperiment,
  ONBOARDING_FUNNEL_STEPS,
  ONBOARDING_FUNNEL_VERSION,
  ONBOARDING_FUNNEL_VARIANTS,
  readOnboardingFunnelVariant,
  resolveOnboardingFunnelVariant,
} from "@/domains/onboarding/funnel-events";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  useOnboardingStore.setState({ shareAnalytics: true });
  __resetOnboardingFunnelEventsForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("onboarding funnel events", () => {
  test("maps experiment arms to funnel variants", () => {
    expect(onboardingFunnelVariantFromExperiment("control")).toBe("control");
    expect(onboardingFunnelVariantFromExperiment("variant-a")).toBe("pared_down");
  });

  test("builds the expected event shape with a stable session id", () => {
    const privacy = buildOnboardingFunnelEvent(
      ONBOARDING_FUNNEL_STEPS.privacyTos,
      {
        userId: "user-123",
        variant: ONBOARDING_FUNNEL_VARIANTS.paredDown,
      },
    );
    const nameVibe = buildOnboardingFunnelEvent(
      ONBOARDING_FUNNEL_STEPS.nameVibe,
      {
        userId: "user-123",
        variant: ONBOARDING_FUNNEL_VARIANTS.paredDown,
      },
    );

    expect(privacy.session_id).toBeTruthy();
    expect(nameVibe.session_id).toBe(privacy.session_id);
    expect(privacy.daemon_event_id).toHaveLength(36);
    expect(privacy).toMatchObject({
      type: "onboarding",
      screen: "privacy_tos",
      step_name: "privacy_tos",
      step_index: 0,
      user_id: "user-123",
      funnel_version: ONBOARDING_FUNNEL_VERSION,
      ab_variant: "pared_down",
    });
    expect(nameVibe).toMatchObject({
      screen: "name_vibe",
      step_name: "name_vibe",
      step_index: 1,
      user_id: "user-123",
      funnel_version: ONBOARDING_FUNNEL_VERSION,
      ab_variant: "pared_down",
    });
    expect(privacy.completed_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  test("persists the assigned funnel variant for the session", () => {
    expect(
      resolveOnboardingFunnelVariant(ONBOARDING_FUNNEL_VARIANTS.paredDown),
    ).toBe("pared_down");
    expect(
      resolveOnboardingFunnelVariant(ONBOARDING_FUNNEL_VARIANTS.control),
    ).toBe("pared_down");
    expect(readOnboardingFunnelVariant()).toBe("pared_down");
  });

  test("an explicit cast variant overrides a stale stored variant", () => {
    // Simulate a user who saw the privacy screen under the legacy A/B split and
    // had `pared_down` cached for the session.
    resolveOnboardingFunnelVariant(ONBOARDING_FUNNEL_VARIANTS.paredDown);
    expect(readOnboardingFunnelVariant()).toBe("pared_down");

    // The cast arm passes its deterministic variant explicitly; the built event
    // must report `cast`, never the stale stored `pared_down`.
    const castDone = buildOnboardingFunnelEvent(
      ONBOARDING_FUNNEL_STEPS.castDone,
      {
        userId: "user-123",
        variant: ONBOARDING_FUNNEL_VARIANTS.cast,
      },
    );

    expect(castDone).toMatchObject({
      screen: "cast_done",
      step_name: "cast_done",
      step_index: 5,
      ab_variant: "cast",
    });
    // The cast emit must not mutate the stored A/B variant either.
    expect(readOnboardingFunnelVariant()).toBe("pared_down");
  });

  test("uses control step indices for the existing funnel", () => {
    const tools = buildOnboardingFunnelEvent(
      ONBOARDING_FUNNEL_STEPS.controlTools,
      {
        userId: "user-123",
        variant: ONBOARDING_FUNNEL_VARIANTS.control,
      },
    );

    expect(tools).toMatchObject({
      screen: "tools",
      step_name: "tools",
      step_index: 3,
      user_id: "user-123",
      ab_variant: "control",
      funnel_version: ONBOARDING_FUNNEL_VERSION,
    });
  });

  test("emits fire-and-forget telemetry payloads with the same session id", () => {
    localStorage.setItem("device:share_analytics", "true");
    const fetchMock = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("{}", { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    emitOnboardingFunnelStepCompleted(ONBOARDING_FUNNEL_STEPS.privacyTos, {
      userId: "user-123",
      variant: ONBOARDING_FUNNEL_VARIANTS.paredDown,
    });
    emitOnboardingFunnelStepCompleted(ONBOARDING_FUNNEL_STEPS.gmailConnect, {
      userId: "user-123",
      variant: ONBOARDING_FUNNEL_VARIANTS.paredDown,
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
      ab_variant: "pared_down",
    });
  });

  test("does not emit telemetry until analytics sharing is explicitly opted in", () => {
    const fetchMock = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("{}", { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    emitOnboardingFunnelStepCompleted(ONBOARDING_FUNNEL_STEPS.privacyTos, {
      userId: "user-123",
      variant: ONBOARDING_FUNNEL_VARIANTS.paredDown,
    });

    localStorage.setItem("device:share_analytics", "false");
    emitOnboardingFunnelStepCompleted(ONBOARDING_FUNNEL_STEPS.gmailConnect, {
      userId: "user-123",
      variant: ONBOARDING_FUNNEL_VARIANTS.paredDown,
    });

    localStorage.setItem("device:share_analytics", "true");
    useOnboardingStore.setState({ shareAnalytics: false });
    emitOnboardingFunnelStepCompleted(ONBOARDING_FUNNEL_STEPS.nameVibe, {
      userId: "user-123",
      variant: ONBOARDING_FUNNEL_VARIANTS.paredDown,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
