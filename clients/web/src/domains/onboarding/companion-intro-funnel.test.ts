import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  COMPANION_INTRO_EVENTS,
  COMPANION_INTRO_VERSION,
  type CompanionIntroReport,
} from "@vellumai/ipc-contract";

import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";

// The emitter posts through the generated client (so the session credentials
// the ingest endpoint authenticates are attached); mock the sdk function and
// assert on the typed request body, the way `funnel-events.test.ts` does.
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
  COMPANION_INTRO_FUNNEL_STEPS,
  COMPANION_INTRO_FUNNEL_VERSION,
  companionIntroCohort,
  emitCompanionIntroReport,
} = await import("@/domains/onboarding/companion-intro-funnel");

interface IngestPayload {
  device_id: string;
  assistant_version: string;
  events: Array<Record<string, unknown>>;
}

/** The one event a call put on the wire. */
function emitted(callIndex: number): Record<string, unknown> {
  const options = ingestMock.mock.calls[callIndex]?.[0] as
    | { body: IngestPayload }
    | undefined;
  if (!options) {
    throw new Error(`No ingest call at index ${callIndex}`);
  }
  const event = options.body.events[0];
  if (!event) {
    throw new Error(`No event in the ingest call at index ${callIndex}`);
  }
  return event;
}

/** A report as main pushes one, with the granted microphone as the default. */
function report(
  over: Partial<CompanionIntroReport> = {},
): CompanionIntroReport {
  return {
    event: "exposed",
    beat: "idle",
    introVersion: COMPANION_INTRO_VERSION,
    micGranted: true,
    at: Date.now(),
    ...over,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  // Never-asked baseline: analytics is opt-out, so null authorizes uploads.
  useOnboardingStore.setState({ shareAnalytics: null });
  ingestMock.mockClear();
});

describe("the companion introduction's funnel", () => {
  test("puts the run on the wire as an onboarding funnel step", () => {
    emitCompanionIntroReport(report());

    expect(emitted(0)).toMatchObject({
      type: "onboarding",
      step_name: "companion_intro_exposed",
      step_index: 0,
      screen: "idle",
      funnel_version: COMPANION_INTRO_FUNNEL_VERSION,
      ab_variant: `intro${COMPANION_INTRO_VERSION}_mic_granted`,
      outcome: "completed",
    });
  });

  /**
   * The whole reason the beat rides every report: drop-off has to be readable
   * per card, or all anybody learns is how many runs ended somewhere.
   */
  test("carries the beat as the screen", () => {
    emitCompanionIntroReport(report({ event: "advanced", beat: "share" }));

    expect(emitted(0)).toMatchObject({
      step_name: "companion_intro_advanced",
      screen: "share",
    });
  });

  // A refusal is the one moment of a run that is not the run working.
  test("marks a dismissal skipped and everything else completed", () => {
    emitCompanionIntroReport(report({ event: "dismissed", beat: "key" }));
    emitCompanionIntroReport(report({ event: "completed", beat: "try" }));

    expect(emitted(0)).toMatchObject({
      step_name: "companion_intro_dismissed",
      screen: "key",
      outcome: "skipped",
    });
    expect(emitted(1)).toMatchObject({
      step_name: "companion_intro_completed",
      outcome: "completed",
    });
  });

  /**
   * The rehearsal the Talk beat asks for and the real call the last beat starts
   * are the same moment under two very different promises, and the beat is what
   * tells them apart.
   */
  test("tells the rehearsal apart from the real call", () => {
    emitCompanionIntroReport(report({ event: "offer_taken", beat: "talk" }));
    emitCompanionIntroReport(report({ event: "offer_taken", beat: "try" }));

    expect(emitted(0)).toMatchObject({
      step_name: "companion_intro_offer_taken",
      screen: "talk",
    });
    expect(emitted(1)).toMatchObject({
      step_name: "companion_intro_offer_taken",
      screen: "try",
    });
  });

  /**
   * Both facts a row has to be read against, on every row. The microphone
   * changes what two of the beats say, so a run without it is a different run;
   * the version separates this run from the four-beat one it replaced.
   */
  test("stamps the run and the microphone on every event", () => {
    for (const event of COMPANION_INTRO_EVENTS) {
      emitCompanionIntroReport(report({ event, micGranted: false }));
    }

    expect(ingestMock).toHaveBeenCalledTimes(COMPANION_INTRO_EVENTS.length);
    for (let index = 0; index < COMPANION_INTRO_EVENTS.length; index += 1) {
      expect(emitted(index)).toMatchObject({
        funnel_version: COMPANION_INTRO_FUNNEL_VERSION,
        ab_variant: `intro${COMPANION_INTRO_VERSION}_mic_ungranted`,
      });
    }
  });

  /**
   * A report main held because nothing was listening can be handed over much
   * later, so the row says when the moment happened rather than when it was
   * collected. Otherwise the one ending this buffering exists for is dated to
   * the launch that picked it up.
   */
  test("dates a report by the moment main saw it, not the moment it arrived", () => {
    const hoursAgo = Date.now() - 3 * 60 * 60 * 1000;

    emitCompanionIntroReport(
      report({ event: "dismissed", beat: "meet", at: hoursAgo }),
    );

    expect(emitted(0)).toMatchObject({
      recorded_at: hoursAgo,
      completed_at: new Date(hoursAgo).toISOString(),
    });
  });

  // Not an arm: nothing is randomized and nothing is being compared. The
  // cohort is the two facts above, which is what `ab_variant` carries here.
  test("reads the cohort off the report rather than a variant", () => {
    expect(companionIntroCohort(report({ micGranted: true }))).toBe(
      `intro${COMPANION_INTRO_VERSION}_mic_granted`,
    );
    expect(companionIntroCohort(report({ introVersion: 1 }))).toBe(
      "intro1_mic_granted",
    );
  });

  /**
   * Every moment main can report has a step, and each one is its own row: a
   * moment sharing a step name with another would be two questions answered by
   * one number.
   */
  test("gives every moment of a run a step of its own", () => {
    const steps = COMPANION_INTRO_EVENTS.map(
      (event) => COMPANION_INTRO_FUNNEL_STEPS[event],
    );

    expect(new Set(steps.map((step) => step.stepName)).size).toBe(steps.length);
    expect(new Set(steps.map((step) => step.stepIndex)).size).toBe(
      steps.length,
    );
  });

  // The run ships to everyone, so the consent gate is the only thing between a
  // moment and a row. It is the emitter's, and this rides it.
  test("says nothing after an explicit analytics opt-out", () => {
    useOnboardingStore.setState({ shareAnalytics: false });

    emitCompanionIntroReport(report());

    expect(ingestMock).not.toHaveBeenCalled();
  });
});
