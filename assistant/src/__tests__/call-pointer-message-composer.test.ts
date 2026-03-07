import { describe, expect, test } from "bun:test";
import { mock } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import {
  buildPointerInstruction,
  type CallPointerMessageContext,
  getPointerFallbackMessage,
} from "../calls/call-pointer-message-composer.js";

// ---------------------------------------------------------------------------
// Deterministic fallback templates
// ---------------------------------------------------------------------------

describe("getPointerFallbackMessage", () => {
  test("started without verification code", () => {
    const msg = getPointerFallbackMessage({
      scenario: "started",
      phoneNumber: "+15551234567",
    });
    expect(msg).toContain("Call to +15551234567 started");
    expect(msg).not.toContain("Verification code");
  });

  test("started with verification code", () => {
    const msg = getPointerFallbackMessage({
      scenario: "started",
      phoneNumber: "+15551234567",
      verificationCode: "1234",
    });
    expect(msg).toContain("Verification code: 1234");
    expect(msg).toContain("+15551234567");
  });

  test("completed without duration", () => {
    const msg = getPointerFallbackMessage({
      scenario: "completed",
      phoneNumber: "+15559876543",
    });
    expect(msg).toContain("completed");
    expect(msg).toContain("+15559876543");
  });

  test("completed with duration", () => {
    const msg = getPointerFallbackMessage({
      scenario: "completed",
      phoneNumber: "+15559876543",
      duration: "5m 30s",
    });
    expect(msg).toContain("completed (5m 30s)");
  });

  test("failed without reason", () => {
    const msg = getPointerFallbackMessage({
      scenario: "failed",
      phoneNumber: "+15559876543",
    });
    expect(msg).toContain("failed");
    expect(msg).toContain("+15559876543");
  });

  test("failed with reason", () => {
    const msg = getPointerFallbackMessage({
      scenario: "failed",
      phoneNumber: "+15559876543",
      reason: "no answer",
    });
    expect(msg).toContain("failed: no answer");
  });

  test("verification_succeeded defaults to phone channel", () => {
    const msg = getPointerFallbackMessage({
      scenario: "verification_succeeded",
      phoneNumber: "+15559876543",
    });
    expect(msg).toContain("Guardian verification (phone)");
    expect(msg).toContain("succeeded");
  });

  test("verification_succeeded with explicit phone channel", () => {
    const msg = getPointerFallbackMessage({
      scenario: "verification_succeeded",
      phoneNumber: "+15559876543",
      channel: "phone",
    });
    expect(msg).toContain("Guardian verification (phone)");
  });

  test("verification_failed without reason", () => {
    const msg = getPointerFallbackMessage({
      scenario: "verification_failed",
      phoneNumber: "+15559876543",
    });
    expect(msg).toContain("Guardian verification");
    expect(msg).toContain("failed");
  });

  test("verification_failed with reason", () => {
    const msg = getPointerFallbackMessage({
      scenario: "verification_failed",
      phoneNumber: "+15559876543",
      reason: "Max attempts exceeded",
    });
    expect(msg).toContain("failed: Max attempts exceeded");
  });
});

// ---------------------------------------------------------------------------
// Daemon instruction builder
// ---------------------------------------------------------------------------

describe("buildPointerInstruction", () => {
  test("includes event tag, scenario, and phone number", () => {
    const ctx: CallPointerMessageContext = {
      scenario: "started",
      phoneNumber: "+15551234567",
    };
    const instruction = buildPointerInstruction(ctx);
    expect(instruction).toContain("[CALL_STATUS_EVENT]");
    expect(instruction).toContain("Event: started");
    expect(instruction).toContain("Phone number: +15551234567");
  });

  test("includes duration when provided", () => {
    const ctx: CallPointerMessageContext = {
      scenario: "completed",
      phoneNumber: "+15559876543",
      duration: "3m",
    };
    const instruction = buildPointerInstruction(ctx);
    expect(instruction).toContain("Duration: 3m");
  });

  test("includes reason when provided", () => {
    const ctx: CallPointerMessageContext = {
      scenario: "failed",
      phoneNumber: "+15559876543",
      reason: "no answer",
    };
    const instruction = buildPointerInstruction(ctx);
    expect(instruction).toContain("Reason: no answer");
  });

  test("includes verification code when provided", () => {
    const ctx: CallPointerMessageContext = {
      scenario: "started",
      phoneNumber: "+15551234567",
      verificationCode: "42",
    };
    const instruction = buildPointerInstruction(ctx);
    expect(instruction).toContain("Verification code: 42");
  });

  test("includes channel when provided", () => {
    const ctx: CallPointerMessageContext = {
      scenario: "verification_succeeded",
      phoneNumber: "+15559876543",
      channel: "phone",
    };
    const instruction = buildPointerInstruction(ctx);
    expect(instruction).toContain("Channel: phone");
  });

  test("omits optional fields when not provided", () => {
    const ctx: CallPointerMessageContext = {
      scenario: "started",
      phoneNumber: "+15551234567",
    };
    const instruction = buildPointerInstruction(ctx);
    expect(instruction).not.toContain("Duration:");
    expect(instruction).not.toContain("Reason:");
    expect(instruction).not.toContain("Verification code:");
    expect(instruction).not.toContain("Channel:");
  });

  test("ends with generation instructions", () => {
    const ctx: CallPointerMessageContext = {
      scenario: "completed",
      phoneNumber: "+15559876543",
    };
    const instruction = buildPointerInstruction(ctx);
    expect(instruction).toContain("Write a brief");
    expect(instruction).toContain("Preserve all factual details");
  });
});
