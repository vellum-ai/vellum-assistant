/**
 * Unit tests for TwiML generation with voice quality profiles.
 *
 * Tests that generateTwiML correctly uses profile values for
 * ttsProvider, voice, language, transcriptionProvider,
 * profanityFilter, and interruptSensitivity.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { generateTwiML } from "../calls/twilio-routes.js";

describe("generateTwiML with voice quality profile", () => {
  const callSessionId = "test-session-123";
  const relayUrl = "wss://test.example.com/v1/calls/relay";
  const welcomeGreeting = "Hello, how can I help?";

  test('TwiML includes ttsProvider="Google" when profile specifies Google', () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: "en-US",
      transcriptionProvider: "Deepgram",
      ttsProvider: "Google",
      voice: "Google.en-US-Journey-O",
      profanityFilter: false,
      interruptSensitivity: "low",
    });

    expect(twiml).toContain('ttsProvider="Google"');
    expect(twiml).toContain('voice="Google.en-US-Journey-O"');
    expect(twiml).toContain('language="en-US"');
    expect(twiml).toContain('transcriptionProvider="Deepgram"');
  });

  test('TwiML includes ttsProvider="ElevenLabs" when profile specifies ElevenLabs', () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: "en-US",
      transcriptionProvider: "Deepgram",
      ttsProvider: "ElevenLabs",
      voice: "voice123-turbo_v2_5-1_0.5_0.75",
      profanityFilter: false,
      interruptSensitivity: "low",
    });

    expect(twiml).toContain('ttsProvider="ElevenLabs"');
    expect(twiml).toContain('voice="voice123-turbo_v2_5-1_0.5_0.75"');
  });

  test("voice attribute reflects configured Google voice", () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: "en-US",
      transcriptionProvider: "Deepgram",
      ttsProvider: "Google",
      voice: "Google.en-US-Journey-O",
      profanityFilter: false,
      interruptSensitivity: "low",
    });

    expect(twiml).toContain('voice="Google.en-US-Journey-O"');
  });

  test("voice attribute reflects configured ElevenLabs voice", () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: "en-US",
      transcriptionProvider: "Deepgram",
      ttsProvider: "ElevenLabs",
      voice: "abc123-turbo_v2_5-1_0.5_0.75",
      profanityFilter: false,
      interruptSensitivity: "low",
    });

    expect(twiml).toContain('voice="abc123-turbo_v2_5-1_0.5_0.75"');
  });

  test("language attribute reflects configured language", () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: "es-MX",
      transcriptionProvider: "Google",
      ttsProvider: "Google",
      voice: "Google.es-MX-Standard-A",
      profanityFilter: false,
      interruptSensitivity: "low",
    });

    expect(twiml).toContain('language="es-MX"');
  });

  test("transcriptionProvider reflects configured value", () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: "en-US",
      transcriptionProvider: "Google",
      ttsProvider: "Google",
      voice: "Google.en-US-Journey-O",
      profanityFilter: false,
      interruptSensitivity: "low",
    });

    expect(twiml).toContain('transcriptionProvider="Google"');
  });

  test("TwiML properly escapes XML characters in profile values", () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: "en-US",
      transcriptionProvider: "Deepgram",
      ttsProvider: "Google",
      voice: 'voice<>&"test',
      profanityFilter: false,
      interruptSensitivity: "low",
    });

    expect(twiml).toContain('voice="voice&lt;&gt;&amp;&quot;test"');
    expect(twiml).not.toContain('voice="voice<>&"test"');
  });

  test("TwiML includes callSessionId in relay URL", () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: "en-US",
      transcriptionProvider: "Deepgram",
      ttsProvider: "Google",
      voice: "Google.en-US-Journey-O",
      profanityFilter: false,
      interruptSensitivity: "low",
    });

    expect(twiml).toContain(`callSessionId=${callSessionId}`);
  });

  test("TwiML includes interruptible and dtmfDetection attributes", () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: "en-US",
      transcriptionProvider: "Deepgram",
      ttsProvider: "Google",
      voice: "Google.en-US-Journey-O",
      profanityFilter: false,
      interruptSensitivity: "low",
    });

    expect(twiml).toContain('interruptible="true"');
    expect(twiml).toContain('dtmfDetection="true"');
  });

  test("TwiML omits welcomeGreeting attribute when not provided", () => {
    const twiml = generateTwiML(callSessionId, relayUrl, null, {
      language: "en-US",
      transcriptionProvider: "Deepgram",
      ttsProvider: "Google",
      voice: "Google.en-US-Journey-O",
      profanityFilter: false,
      interruptSensitivity: "low",
    });

    expect(twiml).not.toContain("welcomeGreeting=");
  });

  test('TwiML includes profanityFilter="false"', () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: "en-US",
      transcriptionProvider: "Deepgram",
      ttsProvider: "Google",
      voice: "Google.en-US-Journey-O",
      profanityFilter: false,
      interruptSensitivity: "low",
    });

    expect(twiml).toContain('profanityFilter="false"');
  });

  test('TwiML includes interruptSensitivity="low" when profile has low', () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: "en-US",
      transcriptionProvider: "Deepgram",
      ttsProvider: "Google",
      voice: "Google.en-US-Journey-O",
      profanityFilter: false,
      interruptSensitivity: "low",
    });

    expect(twiml).toContain('interruptSensitivity="low"');
  });

  test("custom interruptSensitivity values are reflected correctly", () => {
    const twimlMedium = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        transcriptionProvider: "Deepgram",
        ttsProvider: "Google",
        voice: "Google.en-US-Journey-O",
        profanityFilter: false,
        interruptSensitivity: "medium",
      },
    );

    expect(twimlMedium).toContain('interruptSensitivity="medium"');

    const twimlHigh = generateTwiML(
      callSessionId,
      relayUrl,
      welcomeGreeting,
      {
        language: "en-US",
        transcriptionProvider: "Deepgram",
        ttsProvider: "Google",
        voice: "Google.en-US-Journey-O",
        profanityFilter: false,
        interruptSensitivity: "high",
      },
    );

    expect(twimlHigh).toContain('interruptSensitivity="high"');
  });
});
