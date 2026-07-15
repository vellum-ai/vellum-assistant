import { beforeEach, describe, expect, mock, test } from "bun:test";

import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";

// The emitter posts through the generated client (so the session credentials
// the ingest endpoint authenticates are attached); mock the sdk function and
// assert on the typed request body.
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

const {
  __resetOnboardingFunnelEventsForTests,
  buildOnboardingFunnelEvent,
  emitOnboardingFunnelStepCompleted,
  emitResearchOnboardingStepCompleted,
  emitResearchOnboardingCheckinCalendarOpened,
  ONBOARDING_FUNNEL_STEPS,
  ONBOARDING_FUNNEL_VERSION,
  RESEARCH_ONBOARDING_FUNNEL_STEPS,
  RESEARCH_ONBOARDING_FUNNEL_VERSION,
} = await import("@/domains/onboarding/funnel-events");

interface IngestPayload {
  device_id: string;
  assistant_version: string;
  events: Array<Record<string, unknown>>;
}

function ingestPayload(callIndex: number): IngestPayload {
  const options = ingestMock.mock.calls[callIndex]?.[0] as
    { body: IngestPayload } | undefined;
  if (!options) throw new Error(`No ingest call at index ${callIndex}`);
  return options.body;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  useOnboardingStore.setState({ shareAnalytics: true });
  __resetOnboardingFunnelEventsForTests();
  ingestMock.mockClear();
});

describe("onboarding funnel events", () => {
  test("builds the expected event shape with a stable session id", () => {
    const privacy = buildOnboardingFunnelEvent(
      ONBOARDING_FUNNEL_STEPS.privacyTos,
      {
        userId: "user-123",
      },
    );
    const nameVibe = buildOnboardingFunnelEvent(
      ONBOARDING_FUNNEL_STEPS.nameVibe,
      {
        userId: "user-123",
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
      ab_variant: "control",
    });
    expect(nameVibe).toMatchObject({
      screen: "name_vibe",
      step_name: "name_vibe",
      step_index: 1,
      user_id: "user-123",
      funnel_version: ONBOARDING_FUNNEL_VERSION,
      ab_variant: "control",
    });
    expect(privacy.completed_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  test("defaults ab_variant to control when no variant is passed", () => {
    const event = buildOnboardingFunnelEvent(ONBOARDING_FUNNEL_STEPS.nameVibe, {
      userId: "user-123",
    });
    expect(event.ab_variant).toBe("control");
  });

  test("uses control step indices for the existing funnel", () => {
    const tools = buildOnboardingFunnelEvent(
      ONBOARDING_FUNNEL_STEPS.controlTools,
      {
        userId: "user-123",
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

    emitOnboardingFunnelStepCompleted(ONBOARDING_FUNNEL_STEPS.privacyTos, {
      userId: "user-123",
    });
    emitOnboardingFunnelStepCompleted(ONBOARDING_FUNNEL_STEPS.gmailConnect, {
      userId: "user-123",
    });

    expect(ingestMock).toHaveBeenCalledTimes(2);
    const firstEvent = ingestPayload(0).events[0];
    const secondEvent = ingestPayload(1).events[0];

    expect(ingestPayload(0).device_id).toBeTruthy();
    expect(firstEvent?.session_id).toBeTruthy();
    expect(secondEvent?.session_id).toBe(firstEvent?.session_id);
    expect(secondEvent).toMatchObject({
      screen: "gmail_connect",
      step_name: "gmail_connect",
      step_index: 2,
      user_id: "user-123",
      funnel_version: ONBOARDING_FUNNEL_VERSION,
      ab_variant: "control",
    });
  });

  test("stamps research-onboarding steps with the research funnel version", () => {
    localStorage.setItem("device:share_analytics", "true");

    emitResearchOnboardingStepCompleted(RESEARCH_ONBOARDING_FUNNEL_STEPS.form, {
      userId: "user-123",
    });
    // A skip is recorded against the same step, tagged outcome: "skipped".
    emitResearchOnboardingStepCompleted(
      RESEARCH_ONBOARDING_FUNNEL_STEPS.suggestions,
      { userId: "user-123", outcome: "skipped" },
    );

    expect(ingestMock).toHaveBeenCalledTimes(2);
    const firstEvent = ingestPayload(0).events[0];
    const secondEvent = ingestPayload(1).events[0];

    expect(firstEvent).toMatchObject({
      type: "onboarding",
      screen: "research_form",
      step_name: "research_form",
      step_index: 0,
      user_id: "user-123",
      funnel_version: RESEARCH_ONBOARDING_FUNNEL_VERSION,
      ab_variant: "control",
      // Continue-only steps default to "completed".
      outcome: "completed",
    });
    // Shares the funnel session id with the rest of the journey.
    expect(secondEvent?.session_id).toBe(firstEvent?.session_id);
    expect(secondEvent).toMatchObject({
      step_name: "research_suggestions",
      step_index: 10,
      funnel_version: RESEARCH_ONBOARDING_FUNNEL_VERSION,
      outcome: "skipped",
    });
  });

  test("emits the check-in calendar click on the research funnel", () => {
    localStorage.setItem("device:share_analytics", "true");

    emitResearchOnboardingCheckinCalendarOpened({ userId: "user-123" });

    expect(ingestMock).toHaveBeenCalledTimes(1);
    const event = ingestPayload(0).events[0];
    expect(event).toMatchObject({
      type: "onboarding",
      step_name: "research_checkin_open",
      step_index: 11,
      user_id: "user-123",
      funnel_version: RESEARCH_ONBOARDING_FUNNEL_VERSION,
      ab_variant: "control",
      outcome: "completed",
    });
  });

  test("does not emit research telemetry until analytics sharing is opted in", () => {
    useOnboardingStore.setState({ shareAnalytics: false });

    emitResearchOnboardingStepCompleted(RESEARCH_ONBOARDING_FUNNEL_STEPS.form, {
      userId: "user-123",
    });

    expect(ingestMock).not.toHaveBeenCalled();
  });

  test("emits by default (opt-out) but honors an explicit analytics opt-out", () => {
    // Never-asked: no device preference on record — analytics is opt-out, so
    // the event emits.
    emitOnboardingFunnelStepCompleted(ONBOARDING_FUNNEL_STEPS.privacyTos, {
      userId: "user-123",
    });
    expect(ingestMock).toHaveBeenCalledTimes(1);

    // An explicit device opt-out stops uploads.
    localStorage.setItem("device:share_analytics", "false");
    emitOnboardingFunnelStepCompleted(ONBOARDING_FUNNEL_STEPS.gmailConnect, {
      userId: "user-123",
    });
    expect(ingestMock).toHaveBeenCalledTimes(1);

    // The in-memory store must agree: a failed opt-out write cannot leave an
    // older stored opt-in authorizing a new event.
    localStorage.setItem("device:share_analytics", "true");
    useOnboardingStore.setState({ shareAnalytics: false });
    emitOnboardingFunnelStepCompleted(ONBOARDING_FUNNEL_STEPS.nameVibe, {
      userId: "user-123",
    });
    expect(ingestMock).toHaveBeenCalledTimes(1);
  });
});
