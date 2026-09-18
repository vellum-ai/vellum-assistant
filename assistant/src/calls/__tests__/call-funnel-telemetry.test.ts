/**
 * Phone-call funnel rows: which ones the call store records and what they say.
 *
 * The recorder is mocked, as in `live-voice-session-telemetry.test.ts`: the
 * outbox and its consent gate are covered by `telemetry-events-outbox.test.ts`.
 * What these tests pin is the wiring that decides whether a row exists at all,
 * which is where the measurement silently goes wrong: a call that never
 * connects still has to count, a terminal status has to emit exactly one end
 * row however many writes follow it, and a call nobody spoke on has to say so.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const recordPhoneCallStarted = mock(() => null);
const recordPhoneCallEnded = mock(() => null);

// Spread the real module rather than replacing it: the call store pulls other
// recorders out of it, and a bare replacement makes those imports fail.
const onboardingEventsStore =
  await import("../../onboarding/onboarding-events-store.js");
mock.module("../../onboarding/onboarding-events-store.js", () => ({
  ...onboardingEventsStore,
  recordPhoneCallStarted,
  recordPhoneCallEnded,
}));

import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { conversations } from "../../persistence/schema/index.js";

await initializeDb();

// Values load after `mock.module` so the store picks up the mocked recorder.
const { createCallSession, recordCallEvent, updateCallSession } =
  await import("../call-store.js");

let conversationSeq = 0;

function makeConversation(): string {
  const id = `conv-funnel-${++conversationSeq}`;
  const now = Date.now();
  getDb()
    .insert(conversations)
    .values({
      id,
      title: `Test conversation ${id}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

function startCall(opts?: {
  direction?: "inbound" | "outbound";
  callMode?: string;
}): string {
  const session = createCallSession({
    conversationId: makeConversation(),
    provider: "twilio",
    direction: opts?.direction ?? "inbound",
    fromNumber: "+15550100",
    toNumber: "+15550101",
    ...(opts?.callMode !== undefined ? { callMode: opts.callMode } : {}),
  });
  return session.id;
}

beforeEach(() => {
  recordPhoneCallStarted.mockClear();
  recordPhoneCallEnded.mockClear();
});

describe("call funnel start rows", () => {
  test("an inbound call counts the moment its session row exists", () => {
    // Before the provider has dialled and before any preflight can reject it:
    // a call that never connects is the one the funnel most needs to count.
    const callSessionId = startCall({ callMode: "normal" });

    expect(recordPhoneCallStarted).toHaveBeenCalledTimes(1);
    expect(recordPhoneCallStarted).toHaveBeenCalledWith({
      callSessionId,
      screen: "started_inbound:normal",
    });
  });

  test("an outbound call is stamped by the direction it states", () => {
    // Stated, not inferred: a verification or invite call dials out and
    // carries no task, so task presence would misread as inbound.
    startCall({ direction: "outbound", callMode: "verification" });

    expect(recordPhoneCallStarted).toHaveBeenCalledWith(
      expect.objectContaining({ screen: "started_outbound:verification" }),
    );
  });

  test("an ordinary call stamps the normal mode it never writes", () => {
    // createInboundVoiceSession and startCall leave callMode null; only the
    // verification and invite flows set one.
    startCall();

    expect(recordPhoneCallStarted).toHaveBeenCalledWith(
      expect.objectContaining({ screen: "started_inbound:normal" }),
    );
  });
});

describe("call funnel end rows", () => {
  test("a completed call that took a turn reports no silence", () => {
    const callSessionId = startCall({ callMode: "normal" });
    updateCallSession(callSessionId, { status: "in_progress" });
    recordCallEvent(callSessionId, "call_connected");
    recordCallEvent(callSessionId, "caller_spoke", {
      transcript: "hello",
      transport: "media-stream",
    });

    updateCallSession(callSessionId, { status: "completed" });

    expect(recordPhoneCallEnded).toHaveBeenCalledTimes(1);
    expect(recordPhoneCallEnded).toHaveBeenCalledWith({
      callSessionId,
      screen: "ended_completed",
      outcome: "completed",
    });
  });

  test("a call that never connected is silent for that reason", () => {
    const callSessionId = startCall({ callMode: "normal" });

    updateCallSession(callSessionId, { status: "failed" });

    expect(recordPhoneCallEnded).toHaveBeenCalledWith({
      callSessionId,
      screen: "ended_failed:silent_no_connect",
      outcome: "failed",
    });
  });

  test("a connected call nobody spoke on is silent on the line", () => {
    // The distinction the rate lives on: the telephony leg worked and the
    // conversation still never started.
    const callSessionId = startCall({ callMode: "normal" });
    updateCallSession(callSessionId, { status: "in_progress" });
    recordCallEvent(callSessionId, "call_connected");

    updateCallSession(callSessionId, { status: "completed" });

    expect(recordPhoneCallEnded).toHaveBeenCalledWith(
      expect.objectContaining({ screen: "ended_completed:silent_no_turn" }),
    );
  });

  test("a call where only digits were pressed took no turn", () => {
    // DTMF digits ride `caller_spoke` too; only a transcript is a turn.
    const callSessionId = startCall({ callMode: "normal" });
    updateCallSession(callSessionId, { status: "in_progress" });
    recordCallEvent(callSessionId, "call_connected");
    recordCallEvent(callSessionId, "caller_spoke", {
      dtmfDigit: "4",
      transport: "media-stream",
    });

    updateCallSession(callSessionId, { status: "completed" });

    expect(recordPhoneCallEnded).toHaveBeenCalledWith(
      expect.objectContaining({ screen: "ended_completed:silent_no_turn" }),
    );
  });

  test("a cancelled call completed its course", () => {
    // Only an error is a failure; a call cancelled before it connected ran
    // exactly as far as it was asked to.
    const callSessionId = startCall({ callMode: "normal" });

    updateCallSession(callSessionId, { status: "cancelled" });

    expect(recordPhoneCallEnded).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "completed" }),
    );
  });

  test("only the first terminal write records an end", () => {
    // Terminal states are immutable, so the rejected second write must not
    // produce a second row to pair with the one start.
    const callSessionId = startCall({ callMode: "normal" });
    updateCallSession(callSessionId, { status: "completed" });

    updateCallSession(callSessionId, { status: "failed" });

    expect(recordPhoneCallEnded).toHaveBeenCalledTimes(1);
    expect(recordPhoneCallEnded).toHaveBeenCalledWith(
      expect.objectContaining({ screen: "ended_completed:silent_no_connect" }),
    );
  });

  test("a non-status update records nothing", () => {
    const callSessionId = startCall({ callMode: "normal" });

    updateCallSession(callSessionId, { providerCallSid: "CA-test" });

    expect(recordPhoneCallEnded).not.toHaveBeenCalled();
  });
});
