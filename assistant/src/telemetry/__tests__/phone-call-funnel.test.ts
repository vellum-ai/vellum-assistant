import { describe, expect, it } from "bun:test";

import {
  PHONE_CALL_STEPS,
  phoneCallEndScreen,
  phoneCallSilenceReason,
  phoneCallStartScreen,
} from "../phone-call-funnel.js";

describe("phoneCallStartScreen", () => {
  it("stamps the direction and the call mode", () => {
    expect(phoneCallStartScreen("inbound", "normal")).toBe(
      "started_inbound:normal",
    );
    expect(phoneCallStartScreen("outbound", "verification")).toBe(
      "started_outbound:verification",
    );
  });

  it("reads an unwritten mode as the ordinary call it is", () => {
    // Only verification and invite calls write a mode, so a null there is a
    // normal conversation rather than a dimension nobody filled in.
    expect(phoneCallStartScreen("inbound", null)).toBe(
      "started_inbound:normal",
    );
    expect(phoneCallStartScreen("inbound")).toBe("started_inbound:normal");
  });

  it("keeps the longest stamp inside the wire field's 64-char bound", () => {
    const longest = phoneCallStartScreen("outbound", "verification");
    expect(longest.length).toBeLessThanOrEqual(64);
  });
});

describe("phoneCallSilenceReason", () => {
  it("blames the connection when the call never reached the caller", () => {
    // Nothing that happens on a live call can be held against one that never
    // connected: nobody was there to speak.
    expect(phoneCallSilenceReason({ connected: false })).toBe("no_connect");
  });

  it("reports a connected call that took no turn as silence on the line", () => {
    expect(phoneCallSilenceReason({ connected: true })).toBe("no_turn");
  });
});

describe("phoneCallEndScreen", () => {
  it("stamps the terminal status on a call that took a turn", () => {
    expect(phoneCallEndScreen("completed")).toBe("ended_completed");
    expect(phoneCallEndScreen("failed", null)).toBe("ended_failed");
  });

  it("carries the silence classification when no turn was taken", () => {
    expect(phoneCallEndScreen("failed", "no_connect")).toBe(
      "ended_failed:silent_no_connect",
    );
    expect(phoneCallEndScreen("completed", "no_turn")).toBe(
      "ended_completed:silent_no_turn",
    );
  });
});

describe("PHONE_CALL_STEPS", () => {
  it("orders the pair the warehouse subtracts", () => {
    // Duration is the gap between these two rows, so their order is part of
    // the contract rather than a label.
    expect(PHONE_CALL_STEPS.callStarted.stepIndex).toBe(0);
    expect(PHONE_CALL_STEPS.callEnded.stepIndex).toBe(1);
    expect(PHONE_CALL_STEPS.callStarted.stepName).toBe("phone_call_started");
    expect(PHONE_CALL_STEPS.callEnded.stepName).toBe("phone_call_ended");
  });
});
