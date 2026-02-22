/**
 * Unit tests for TwiML generation with voice quality profiles.
 *
 * Tests that generateTwiML correctly uses profile values for
 * ttsProvider, voice, language, and transcriptionProvider.
 */
import { describe, test, expect, mock } from 'bun:test';

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { generateTwiML } from '../calls/twilio-routes.js';

describe('generateTwiML with voice quality profile', () => {
  const callSessionId = 'test-session-123';
  const relayUrl = 'wss://test.example.com/v1/calls/relay';
  const welcomeGreeting = 'Hello, how can I help?';

  test('TwiML includes ttsProvider="Google" when profile specifies Google', () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      ttsProvider: 'Google',
      voice: 'Google.en-US-Journey-O',
    });

    expect(twiml).toContain('ttsProvider="Google"');
    expect(twiml).toContain('voice="Google.en-US-Journey-O"');
    expect(twiml).toContain('language="en-US"');
    expect(twiml).toContain('transcriptionProvider="Deepgram"');
  });

  test('TwiML includes ttsProvider="ElevenLabs" when profile specifies ElevenLabs', () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      ttsProvider: 'ElevenLabs',
      voice: 'voice123-turbo_v2_5-1_0.5_0.75',
    });

    expect(twiml).toContain('ttsProvider="ElevenLabs"');
    expect(twiml).toContain('voice="voice123-turbo_v2_5-1_0.5_0.75"');
  });

  test('voice attribute reflects configured voice for twilio_standard mode', () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      ttsProvider: 'Google',
      voice: 'Google.en-US-Journey-O',
    });

    expect(twiml).toContain('voice="Google.en-US-Journey-O"');
  });

  test('voice attribute reflects configured voice for twilio_elevenlabs_tts mode', () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      ttsProvider: 'ElevenLabs',
      voice: 'abc123-turbo_v2_5-1_0.5_0.75',
    });

    expect(twiml).toContain('voice="abc123-turbo_v2_5-1_0.5_0.75"');
  });

  test('language attribute reflects configured language', () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: 'es-MX',
      transcriptionProvider: 'Google',
      ttsProvider: 'Google',
      voice: 'Google.es-MX-Standard-A',
    });

    expect(twiml).toContain('language="es-MX"');
  });

  test('transcriptionProvider reflects configured value', () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: 'en-US',
      transcriptionProvider: 'Google',
      ttsProvider: 'Google',
      voice: 'Google.en-US-Journey-O',
    });

    expect(twiml).toContain('transcriptionProvider="Google"');
  });

  test('TwiML properly escapes XML characters in profile values', () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      ttsProvider: 'Google',
      voice: 'voice<>&"test',
    });

    expect(twiml).toContain('voice="voice&lt;&gt;&amp;&quot;test"');
    expect(twiml).not.toContain('voice="voice<>&"test"');
  });

  test('TwiML includes callSessionId in relay URL', () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      ttsProvider: 'Google',
      voice: 'Google.en-US-Journey-O',
    });

    expect(twiml).toContain(`callSessionId=${callSessionId}`);
  });

  test('TwiML includes interruptible and dtmfDetection attributes', () => {
    const twiml = generateTwiML(callSessionId, relayUrl, welcomeGreeting, {
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      ttsProvider: 'Google',
      voice: 'Google.en-US-Journey-O',
    });

    expect(twiml).toContain('interruptible="true"');
    expect(twiml).toContain('dtmfDetection="true"');
  });
});
