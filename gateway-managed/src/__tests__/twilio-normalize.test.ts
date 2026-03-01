import { describe, expect, test } from "bun:test";

import {
  normalizeManagedTwilioSmsPayload,
  normalizeManagedTwilioVoicePayload,
} from "../twilio-normalize.js";

describe("managed Twilio payload normalization", () => {
  test("normalizes SMS payload into shared managed inbound event shape", () => {
    const receivedAt = "2026-03-01T18:30:00.000Z";
    const event = normalizeManagedTwilioSmsPayload({
      From: "+15550000000",
      To: "+15559999999",
      Body: "hello sms",
      MessageSid: "SM123",
    }, receivedAt);

    expect(event).toEqual({
      version: "v1",
      sourceChannel: "sms",
      receivedAt,
      message: {
        content: "hello sms",
        conversationExternalId: "+15550000000",
        externalMessageId: "SM123",
      },
      actor: {
        actorExternalId: "+15550000000",
        displayName: "+15550000000",
      },
      source: {
        updateId: "SM123",
        messageId: "SM123",
        to: "+15559999999",
      },
      raw: {
        From: "+15550000000",
        To: "+15559999999",
        Body: "hello sms",
        MessageSid: "SM123",
        _to: "+15559999999",
      },
    });
  });

  test("normalizes voice payload into shared managed inbound event shape", () => {
    const receivedAt = "2026-03-01T18:31:00.000Z";
    const event = normalizeManagedTwilioVoicePayload({
      From: "+15550000001",
      To: "+15559999998",
      CallSid: "CA123",
      CallStatus: "ringing",
    }, receivedAt);

    expect(event).toEqual({
      version: "v1",
      sourceChannel: "voice",
      receivedAt,
      message: {
        content: "",
        conversationExternalId: "+15550000001",
        externalMessageId: "CA123",
      },
      actor: {
        actorExternalId: "+15550000001",
        displayName: "+15550000001",
      },
      source: {
        updateId: "CA123",
        messageId: "CA123",
        to: "+15559999998",
        callStatus: "ringing",
      },
      raw: {
        From: "+15550000001",
        To: "+15559999998",
        CallSid: "CA123",
        CallStatus: "ringing",
        _to: "+15559999998",
        _call_status: "ringing",
      },
    });
  });
});
