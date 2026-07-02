/**
 * Unit tests for `<Connect><Stream>` TwiML generation.
 *
 * Every call connects over the media-stream transport; these tests exercise
 * the TwiML serializer only — handshake metadata encoding (path segments +
 * `<Parameter>` children), XML escaping, and structure.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { generateStreamTwiML } from "../calls/twilio-routes.js";

describe("generateStreamTwiML", () => {
  const callSessionId = "stream-session-1";
  const streamUrl = "wss://test.example.com/webhooks/twilio/media-stream";

  test("emits <Stream> element with callSessionId as path segment", () => {
    const twiml = generateStreamTwiML(callSessionId, streamUrl);

    expect(twiml).toContain("<Stream");
    // callSessionId is encoded as a path segment, not a query param
    expect(twiml).toContain(
      `url="wss://test.example.com/webhooks/twilio/media-stream/${callSessionId}"`,
    );
    // No query params should be present
    expect(twiml).not.toContain("?callSessionId=");
  });

  test("includes callSessionId as <Parameter>", () => {
    const twiml = generateStreamTwiML(callSessionId, streamUrl);

    expect(twiml).toContain(
      `<Parameter name="callSessionId" value="${callSessionId}" />`,
    );
  });

  test("includes auth token as path segment and as <Parameter> when provided", () => {
    const twiml = generateStreamTwiML(
      callSessionId,
      streamUrl,
      "test-relay-token-123",
    );

    // Token as path segment for gateway auth during WS upgrade
    expect(twiml).toContain(
      `url="wss://test.example.com/webhooks/twilio/media-stream/${callSessionId}/test-relay-token-123"`,
    );
    // Token also in <Parameter> for Twilio start event payload
    expect(twiml).toContain(
      '<Parameter name="token" value="test-relay-token-123" />',
    );
  });

  test("omits token from URL path and Parameter when not provided", () => {
    const twiml = generateStreamTwiML(callSessionId, streamUrl);

    expect(twiml).not.toContain('name="token"');
    // URL should only have callSessionId as path segment, no token
    expect(twiml).toContain(
      `url="wss://test.example.com/webhooks/twilio/media-stream/${callSessionId}"`,
    );
  });

  test("includes custom parameters as <Parameter> elements", () => {
    const twiml = generateStreamTwiML(callSessionId, streamUrl, "tok", {
      verificationSessionId: "vs-123",
    });

    expect(twiml).toContain(
      '<Parameter name="verificationSessionId" value="vs-123" />',
    );
    expect(twiml).toContain(
      `<Parameter name="callSessionId" value="${callSessionId}" />`,
    );
    expect(twiml).toContain('<Parameter name="token" value="tok" />');
  });

  test("callSessionId cannot be overridden by customParameters", () => {
    const twiml = generateStreamTwiML(callSessionId, streamUrl, undefined, {
      callSessionId: "attacker-session",
    });

    // The real callSessionId must win over the custom parameter
    expect(twiml).toContain(
      `<Parameter name="callSessionId" value="${callSessionId}" />`,
    );
    expect(twiml).not.toContain('value="attacker-session"');
    // URL path must also have the correct callSessionId
    expect(twiml).toContain(`/media-stream/${callSessionId}`);
    expect(twiml).not.toContain("attacker-session");
  });

  test("does not include STT/TTS attributes on the Stream element", () => {
    const twiml = generateStreamTwiML(callSessionId, streamUrl);

    expect(twiml).not.toContain("transcriptionProvider=");
    expect(twiml).not.toContain("speechModel=");
    expect(twiml).not.toContain("interruptSensitivity=");
    expect(twiml).not.toContain("ttsProvider=");
    expect(twiml).not.toContain("voice=");
    expect(twiml).not.toContain("language=");
  });

  test("wraps in valid TwiML structure", () => {
    const twiml = generateStreamTwiML(callSessionId, streamUrl);

    expect(twiml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(twiml).toContain("<Response>");
    expect(twiml).toContain("<Connect>");
    expect(twiml).toContain("</Stream>");
    expect(twiml).toContain("</Connect>");
    expect(twiml).toContain("</Response>");
  });

  test("URL-encodes special characters in callSessionId path segment", () => {
    const specialId = "sess&id=1/2";
    const twiml = generateStreamTwiML(specialId, streamUrl);

    // Special characters must be percent-encoded in the path segment
    expect(twiml).toContain("/media-stream/sess%26id%3D1%2F2");
    // But the <Parameter> value should have the raw value (XML-escaped)
    expect(twiml).toContain(
      '<Parameter name="callSessionId" value="sess&amp;id=1/2" />',
    );
  });
});
