/**
 * Unit tests for TwiML generation with voice quality profiles and the
 * Twilio ConversationRelay speech config helper.
 *
 * Tests that generateTwiML correctly uses profile values for
 * ttsProvider, voice, and language, and that STT attributes
 * (transcriptionProvider, speechModel, interruptSensitivity, hints)
 * are driven by the TwilioRelaySpeechConfig helper.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { resolveTelephonySttProfile } from "../calls/stt-profile.js";
import { buildTwilioRelaySpeechConfig } from "../calls/twilio-relay-speech-config.js";
import { generateStreamTwiML, generateTwiML } from "../calls/twilio-routes.js";

// ── Helper to build speech config from raw provider settings ─────────

function speechConfigFor(
  transcriptionProvider: "Deepgram" | "Google",
  speechModel: string | undefined,
  interruptSensitivity: string,
  hints?: string,
) {
  const sttProfile = resolveTelephonySttProfile({
    transcriptionProvider,
    speechModel,
  });
  return buildTwilioRelaySpeechConfig(sttProfile, interruptSensitivity, hints);
}

// ── buildTwilioRelaySpeechConfig unit tests ──────────────────────────

describe("buildTwilioRelaySpeechConfig", () => {
  test("Deepgram: provider and default speechModel are set", () => {
    const config = speechConfigFor("Deepgram", undefined, "low");
    expect(config.transcriptionProvider).toBe("Deepgram");
    expect(config.speechModel).toBe("nova-3");
    expect(config.interruptSensitivity).toBe("low");
    expect(config.hints).toBeUndefined();
  });

  test("Deepgram: explicit speechModel is preserved", () => {
    const config = speechConfigFor("Deepgram", "nova-2-phonecall", "medium");
    expect(config.transcriptionProvider).toBe("Deepgram");
    expect(config.speechModel).toBe("nova-2-phonecall");
    expect(config.interruptSensitivity).toBe("medium");
  });

  test("Google: speechModel is undefined when unset", () => {
    const config = speechConfigFor("Google", undefined, "low");
    expect(config.transcriptionProvider).toBe("Google");
    expect(config.speechModel).toBeUndefined();
  });

  test("Google: legacy Deepgram default nova-3 is stripped", () => {
    const config = speechConfigFor("Google", "nova-3", "low");
    expect(config.transcriptionProvider).toBe("Google");
    expect(config.speechModel).toBeUndefined();
  });

  test("Google: explicit non-legacy speechModel is preserved", () => {
    const config = speechConfigFor("Google", "telephony", "high");
    expect(config.transcriptionProvider).toBe("Google");
    expect(config.speechModel).toBe("telephony");
    expect(config.interruptSensitivity).toBe("high");
  });

  test("hints included when non-empty", () => {
    const config = speechConfigFor("Deepgram", undefined, "low", "Alice,Bob");
    expect(config.hints).toBe("Alice,Bob");
  });

  test("hints undefined when empty string", () => {
    const config = speechConfigFor("Deepgram", undefined, "low", "");
    expect(config.hints).toBeUndefined();
  });

  test("hints undefined when not provided", () => {
    const config = speechConfigFor("Deepgram", undefined, "low");
    expect(config.hints).toBeUndefined();
  });
});

// ── generateTwiML with speech config ─────────────────────────────────

describe("generateTwiML with voice quality profile", () => {
  const callSessionId = "test-session-123";
  const relayUrl = "wss://test.example.com/v1/calls/relay";
  const welcomeGreeting = "Hello, how can I help?";

  test('TwiML includes ttsProvider="Google" when profile specifies Google', () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "Google",
        voice: "Google.en-US-Journey-O",
      },
      speechConfigFor("Deepgram", undefined, "low"),
    );

    expect(twiml).toContain('ttsProvider="Google"');
    expect(twiml).toContain('voice="Google.en-US-Journey-O"');
    expect(twiml).toContain('language="en-US"');
    expect(twiml).toContain('transcriptionProvider="Deepgram"');
  });

  test('TwiML includes ttsProvider="ElevenLabs" when profile specifies ElevenLabs', () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "ElevenLabs",
        voice: "voice123-turbo_v2_5-1_0.5_0.75",
      },
      speechConfigFor("Deepgram", undefined, "low"),
    );

    expect(twiml).toContain('ttsProvider="ElevenLabs"');
    expect(twiml).toContain('voice="voice123-turbo_v2_5-1_0.5_0.75"');
  });

  test("voice attribute reflects configured Google voice", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "Google",
        voice: "Google.en-US-Journey-O",
      },
      speechConfigFor("Deepgram", undefined, "low"),
    );

    expect(twiml).toContain('voice="Google.en-US-Journey-O"');
  });

  test("voice attribute reflects configured ElevenLabs voice", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "ElevenLabs",
        voice: "abc123-turbo_v2_5-1_0.5_0.75",
      },
      speechConfigFor("Deepgram", undefined, "low"),
    );

    expect(twiml).toContain('voice="abc123-turbo_v2_5-1_0.5_0.75"');
  });

  test("language attribute reflects configured language", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "es-MX",
        ttsProvider: "Google",
        voice: "Google.es-MX-Standard-A",
      },
      speechConfigFor("Google", undefined, "low"),
    );

    expect(twiml).toContain('language="es-MX"');
  });

  test("transcriptionProvider reflects Deepgram via speech config", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "ElevenLabs",
        voice: "voice123",
      },
      speechConfigFor("Deepgram", undefined, "low"),
    );

    expect(twiml).toContain('transcriptionProvider="Deepgram"');
    expect(twiml).toContain('speechModel="nova-3"');
  });

  test("transcriptionProvider reflects Google via speech config", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "ElevenLabs",
        voice: "voice123",
      },
      speechConfigFor("Google", undefined, "low"),
    );

    expect(twiml).toContain('transcriptionProvider="Google"');
    expect(twiml).not.toContain("speechModel=");
  });

  test("Google with explicit telephony model includes speechModel", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "ElevenLabs",
        voice: "voice123",
      },
      speechConfigFor("Google", "telephony", "low"),
    );

    expect(twiml).toContain('transcriptionProvider="Google"');
    expect(twiml).toContain('speechModel="telephony"');
  });

  test("Deepgram with explicit model preserves it", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "ElevenLabs",
        voice: "voice123",
      },
      speechConfigFor("Deepgram", "nova-2-phonecall", "low"),
    );

    expect(twiml).toContain('transcriptionProvider="Deepgram"');
    expect(twiml).toContain('speechModel="nova-2-phonecall"');
  });

  test("TwiML properly escapes XML characters in profile values", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "Google",
        voice: 'voice<>&"test',
      },
      speechConfigFor("Deepgram", undefined, "low"),
    );

    expect(twiml).toContain('voice="voice&lt;&gt;&amp;&quot;test"');
    expect(twiml).not.toContain('voice="voice<>&"test"');
  });

  test("TwiML includes callSessionId in relay URL", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "Google",
        voice: "Google.en-US-Journey-O",
      },
      speechConfigFor("Deepgram", undefined, "low"),
    );

    expect(twiml).toContain(`callSessionId=${callSessionId}`);
  });

  test("TwiML includes interruptible and dtmfDetection attributes", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "Google",
        voice: "Google.en-US-Journey-O",
      },
      speechConfigFor("Deepgram", undefined, "low"),
    );

    expect(twiml).toContain('interruptible="true"');
    expect(twiml).toContain('dtmfDetection="true"');
  });

  test("TwiML omits welcomeGreeting attribute when not provided", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      null,
      {
        language: "en-US",
        ttsProvider: "Google",
        voice: "Google.en-US-Journey-O",
      },
      speechConfigFor("Deepgram", undefined, "low"),
    );

    expect(twiml).not.toContain("welcomeGreeting=");
  });

  test('TwiML includes interruptSensitivity="low" from speech config', () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "Google",
        voice: "Google.en-US-Journey-O",
      },
      speechConfigFor("Deepgram", undefined, "low"),
    );

    expect(twiml).toContain('interruptSensitivity="low"');
  });

  test("custom interruptSensitivity values are reflected correctly", () => {
    const twimlMedium = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "Google",
        voice: "Google.en-US-Journey-O",
      },
      speechConfigFor("Deepgram", undefined, "medium"),
    );

    expect(twimlMedium).toContain('interruptSensitivity="medium"');

    const twimlHigh = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "Google",
        voice: "Google.en-US-Journey-O",
      },
      speechConfigFor("Deepgram", undefined, "high"),
    );

    expect(twimlHigh).toContain('interruptSensitivity="high"');
  });

  test("hints attribute present when speech config includes hints", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "ElevenLabs",
        voice: "voice123",
      },
      speechConfigFor("Deepgram", undefined, "low", "Alice,Bob,Vellum"),
    );

    expect(twiml).toContain('hints="Alice,Bob,Vellum"');
  });

  test("hints attribute omitted when speech config has no hints", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "ElevenLabs",
        voice: "voice123",
      },
      speechConfigFor("Deepgram", undefined, "low"),
    );

    expect(twiml).not.toContain("hints=");
  });

  test("hints attribute omitted when speech config hints is empty", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "ElevenLabs",
        voice: "voice123",
      },
      speechConfigFor("Deepgram", undefined, "low", ""),
    );

    expect(twiml).not.toContain("hints=");
  });

  test("XML special characters in hints are escaped properly", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        ttsProvider: "ElevenLabs",
        voice: "voice123",
      },
      speechConfigFor(
        "Deepgram",
        undefined,
        "low",
        'O\'Brien,Smith & Jones,"Dr. Lee"',
      ),
    );

    expect(twiml).toContain(
      'hints="O&apos;Brien,Smith &amp; Jones,&quot;Dr. Lee&quot;"',
    );
    expect(twiml).not.toContain("hints=\"O'Brien");
  });
});

// ── generateStreamTwiML unit tests ────────────────────────────────────
// Tests for the <Connect><Stream> TwiML generator used by the
// media-stream-custom strategy (e.g. OpenAI Whisper).

describe("generateStreamTwiML", () => {
  const callSessionId = "stream-session-1";
  const streamUrl = "wss://test.example.com/webhooks/twilio/media-stream";

  test("emits <Stream> element with callSessionId in URL query params", () => {
    const twiml = generateStreamTwiML(callSessionId, streamUrl);

    expect(twiml).toContain("<Stream");
    expect(twiml).toContain(
      `url="wss://test.example.com/webhooks/twilio/media-stream?callSessionId=${callSessionId}"`,
    );
    expect(twiml).not.toContain("<ConversationRelay");
  });

  test("includes callSessionId as <Parameter>", () => {
    const twiml = generateStreamTwiML(callSessionId, streamUrl);

    expect(twiml).toContain(
      `<Parameter name="callSessionId" value="${callSessionId}" />`,
    );
  });

  test("includes auth token in URL query params and as <Parameter> when provided", () => {
    const twiml = generateStreamTwiML(
      callSessionId,
      streamUrl,
      "test-relay-token-123",
    );

    // Token in URL query params for gateway auth during WS upgrade
    expect(twiml).toContain("token=test-relay-token-123");
    // Token also in <Parameter> for Twilio start event payload
    expect(twiml).toContain(
      '<Parameter name="token" value="test-relay-token-123" />',
    );
  });

  test("omits token from URL and Parameter when not provided", () => {
    const twiml = generateStreamTwiML(callSessionId, streamUrl);

    expect(twiml).not.toContain('name="token"');
    // URL should not contain a token query param
    expect(twiml).not.toContain("token=");
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
    // URL must also have the correct callSessionId
    expect(twiml).toContain(`callSessionId=${callSessionId}`);
    expect(twiml).not.toContain("callSessionId=attacker-session");
  });

  test("does not include ConversationRelay STT attributes", () => {
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
});

// ── Provider-conditional TwiML generation ─────────────────────────────
// These tests verify that the two TwiML generators produce the correct
// structure for each provider strategy:
// - Deepgram/Google -> ConversationRelay with STT attributes
// - OpenAI Whisper -> Stream with no STT attributes

describe("Provider-conditional TwiML generation", () => {
  const callSessionId = "provider-test-1";
  const relayUrl = "wss://test.example.com/v1/calls/relay";
  const streamUrl = "wss://test.example.com/webhooks/twilio/media-stream";

  test("Deepgram: ConversationRelay with transcriptionProvider=Deepgram and speechModel=nova-3", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      null,
      { language: "en-US", ttsProvider: "ElevenLabs", voice: "voice1" },
      speechConfigFor("Deepgram", undefined, "low"),
    );

    expect(twiml).toContain("<ConversationRelay");
    expect(twiml).not.toContain("<Stream");
    expect(twiml).toContain('transcriptionProvider="Deepgram"');
    expect(twiml).toContain('speechModel="nova-3"');
  });

  test("Google Gemini: ConversationRelay with transcriptionProvider=Google (no speechModel when unset)", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      null,
      { language: "en-US", ttsProvider: "ElevenLabs", voice: "voice1" },
      speechConfigFor("Google", undefined, "low"),
    );

    expect(twiml).toContain("<ConversationRelay");
    expect(twiml).not.toContain("<Stream");
    expect(twiml).toContain('transcriptionProvider="Google"');
    expect(twiml).not.toContain("speechModel=");
  });

  test("OpenAI Whisper: Stream path with no ConversationRelay STT attributes", () => {
    const twiml = generateStreamTwiML(callSessionId, streamUrl, "tok");

    expect(twiml).toContain("<Stream");
    expect(twiml).not.toContain("<ConversationRelay");
    expect(twiml).not.toContain("transcriptionProvider=");
    expect(twiml).not.toContain("speechModel=");
    expect(twiml).toContain(
      `<Parameter name="callSessionId" value="${callSessionId}" />`,
    );
  });

  test("ConversationRelay element contains all required STT-related attributes", () => {
    const twiml = generateTwiML(
      callSessionId,
      relayUrl,
      null,
      {
        language: "en-US",
        ttsProvider: "Google",
        voice: "Google.en-US-Journey-O",
      },
      speechConfigFor("Deepgram", "nova-3", "medium", "Alice,Bob"),
    );

    expect(twiml).toContain('transcriptionProvider="Deepgram"');
    expect(twiml).toContain('speechModel="nova-3"');
    expect(twiml).toContain('interruptSensitivity="medium"');
    expect(twiml).toContain('hints="Alice,Bob"');
    expect(twiml).toContain('interruptible="true"');
    expect(twiml).toContain('dtmfDetection="true"');
  });
});
