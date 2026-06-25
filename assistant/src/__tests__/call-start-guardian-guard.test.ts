import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ToolContext } from "../tools/types.js";

let callsEnabled = true;
const startCallInputs: Array<Record<string, unknown>> = [];
let activeVoiceSession: {
  destinationAddress: string | null;
  expectedPhoneE164: string | null;
} | null = null;

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},

    calls: { enabled: callsEnabled },
  }),
}));

mock.module("../calls/call-domain.js", () => ({
  startCall: async (input: Record<string, unknown>) => {
    startCallInputs.push(input);
    return {
      ok: true,
      session: {
        id: "call-session-1",
        toNumber: String(input.phoneNumber ?? ""),
        fromNumber: "+14155550000",
      },
      callSid: "CA-mock",
      callerIdentityMode: "assistant_number",
    };
  },
}));

mock.module("../runtime/channel-verification-service.js", () => ({
  findActiveSession: () => activeVoiceSession,
}));

const { executeCallStart } = await import("../tools/calls/call-start.js");

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "conversation-1",
    assistantId: "self",
    trustClass: "guardian",
  };
}

describe("call_start guardian verification guard", () => {
  beforeEach(() => {
    callsEnabled = true;
    startCallInputs.length = 0;
    activeVoiceSession = null;
  });

  test("blocks call_start when voice guardian verification is active for the same number", async () => {
    activeVoiceSession = {
      destinationAddress: "+14155551234",
      expectedPhoneE164: "+14155551234",
    };

    const result = await executeCallStart(
      {
        phone_number: "(415) 555-1234",
        task: "Test call while verification is active",
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "guardian voice verification call is already active",
    );
    expect(startCallInputs.length).toBe(0);
  });

  test("allows call_start when active guardian verification targets a different number", async () => {
    activeVoiceSession = {
      destinationAddress: "+14155550001",
      expectedPhoneE164: "+14155550001",
    };

    const result = await executeCallStart(
      {
        phone_number: "+14155551234",
        task: "Normal outbound call",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Call initiated successfully.");
    expect(startCallInputs.length).toBe(1);
  });
});
