/**
 * Handler-level tests for ElevenLabs voice webhook branches in handleVoiceWebhook.
 *
 * Tests the WS-A (invalid profile + fallback semantics) and WS-B
 * (elevenlabs_agent guard) paths by mocking resolveVoiceQualityProfile
 * to return specific profiles and asserting on HTTP response status/body.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = realpathSync(mkdtempSync(join(tmpdir(), 'twilio-routes-11labs-test-')));

mock.module('../util/platform.js', () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    model: 'test',
    provider: 'test',
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
  }),
  loadConfig: () => ({
    model: 'test',
    provider: 'test',
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
    calls: {
      voice: {
        mode: 'twilio_standard',
        language: 'en-US',
        transcriptionProvider: 'Deepgram',
        fallbackToStandardOnError: true,
        elevenlabs: {
          voiceId: '',
          voiceModelId: '',
          speed: 1.0,
          stability: 0.5,
          similarityBoost: 0.75,
          useSpeakerBoost: true,
          agentId: '',
          apiBaseUrl: 'https://api.elevenlabs.io',
          registerCallTimeoutMs: 5000,
        },
      },
    },
    ingress: { enabled: false, publicBaseUrl: '' },
  }),
}));

mock.module('../security/secure-keys.js', () => ({
  getSecureKey: () => undefined,
}));

mock.module('../calls/twilio-provider.js', () => ({
  TwilioConversationRelayProvider: class {
    readonly name = 'twilio';
    static getAuthToken(): string | null { return null; }
    static verifyWebhookSignature(): boolean { return true; }
    async initiateCall() { return { callSid: 'CA_mock_test' }; }
    async endCall() { return; }
  },
}));

mock.module('../calls/twilio-config.js', () => ({
  getTwilioConfig: () => ({
    accountSid: 'AC_test',
    authToken: 'test-auth-token',
    phoneNumber: '+15550001111',
    webhookBaseUrl: 'https://test.example.com',
    wssBaseUrl: 'wss://test.example.com',
  }),
}));

// Mock ElevenLabs client — should never be called when guard is active.
// If any test path reaches register-call, the mock will throw to fail the test.
const mockRegisterCall = mock(() => { throw new Error('register-call should not be reached while guard is active'); });

mock.module('../calls/elevenlabs-client.js', () => ({
  ElevenLabsClient: class {
    registerCall = mockRegisterCall;
  },
}));

mock.module('../calls/elevenlabs-config.js', () => ({
  getElevenLabsConfig: () => ({
    apiBaseUrl: 'https://api.elevenlabs.io',
    apiKey: 'test-key',
    agentId: 'agent-abc',
    registerCallTimeoutMs: 5000,
  }),
}));

// Mock resolveVoiceQualityProfile and isVoiceProfileValid so we can control
// the profile returned to handleVoiceWebhook per-test.
import type { VoiceQualityProfile } from '../calls/voice-quality.js';

let mockProfile: VoiceQualityProfile = {
  mode: 'twilio_standard',
  language: 'en-US',
  transcriptionProvider: 'Deepgram',
  ttsProvider: 'Google',
  voice: 'Google.en-US-Journey-O',
  fallbackToStandardOnError: true,
  validationErrors: [],
};

const mockResolveVoiceQualityProfile = mock(() => mockProfile);

mock.module('../calls/voice-quality.js', () => ({
  resolveVoiceQualityProfile: mockResolveVoiceQualityProfile,
  isVoiceProfileValid: (profile: VoiceQualityProfile) => profile.validationErrors.length === 0,
}));

// Mock the ingress URL to avoid config lookup issues
mock.module('../inbound/public-ingress-urls.js', () => ({
  getTwilioRelayUrl: () => 'wss://test.example.com/v1/calls/relay',
  getPublicBaseUrl: () => 'https://test.example.com',
}));

import { initializeDb, getDb, resetDb } from '../memory/db.js';
import { conversations } from '../memory/schema.js';
import {
  createCallSession,
  updateCallSession,
} from '../calls/call-store.js';
import { handleVoiceWebhook } from '../calls/twilio-routes.js';

initializeDb();

// ── Helpers ────────────────────────────────────────────────────────────

let ensuredConvIds = new Set<string>();

function ensureConversation(id: string): void {
  if (ensuredConvIds.has(id)) return;
  const db = getDb();
  const now = Date.now();
  db.insert(conversations).values({
    id,
    title: `Test conversation ${id}`,
    createdAt: now,
    updatedAt: now,
  }).run();
  ensuredConvIds.add(id);
}

function resetTables() {
  const db = getDb();
  db.run('DELETE FROM guardian_action_deliveries');
  db.run('DELETE FROM guardian_action_requests');
  db.run('DELETE FROM processed_callbacks');
  db.run('DELETE FROM call_pending_questions');
  db.run('DELETE FROM call_events');
  db.run('DELETE FROM call_sessions');
  db.run('DELETE FROM messages');
  db.run('DELETE FROM conversations');
  ensuredConvIds = new Set();
}

function createTestSession(convId: string, callSid: string) {
  ensureConversation(convId);
  const session = createCallSession({
    conversationId: convId,
    provider: 'twilio',
    fromNumber: '+15550001111',
    toNumber: '+15559998888',
    task: 'test task',
  });
  updateCallSession(session.id, { providerCallSid: callSid });
  return session;
}

function makeVoiceRequest(sessionId: string, params: Record<string, string>): Request {
  return new Request(`http://127.0.0.1/v1/calls/twilio/voice-webhook?callSessionId=${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('handleVoiceWebhook ElevenLabs branches', () => {
  beforeEach(() => {
    resetTables();
    // Reset mock to default implementation
    mockResolveVoiceQualityProfile.mockReset();
    mockRegisterCall.mockClear();
    // Reset to standard default profile between tests
    mockProfile = {
      mode: 'twilio_standard',
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      ttsProvider: 'Google',
      voice: 'Google.en-US-Journey-O',
      fallbackToStandardOnError: true,
      validationErrors: [],
    };
    mockResolveVoiceQualityProfile.mockImplementation(() => mockProfile);
  });

  afterAll(() => {
    resetDb();
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // ── WS-A: Invalid config + fallback disabled => 500 ────────────────
  test('twilio_elevenlabs_tts invalid config with fallback disabled returns 500', async () => {
    mockProfile = {
      mode: 'twilio_elevenlabs_tts',
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      ttsProvider: 'ElevenLabs',
      voice: '',
      fallbackToStandardOnError: false,
      validationErrors: ['voiceId is required'],
    };

    const session = createTestSession('conv-11labs-1', 'CA_11labs_1');
    const req = makeVoiceRequest(session.id, { CallSid: 'CA_11labs_1' });

    const res = await handleVoiceWebhook(req);

    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('Voice quality configuration error');
    expect(body).toContain('voiceId is required');
  });

  // ── WS-A: Invalid config + fallback enabled => standard TwiML ──────
  test('twilio_elevenlabs_tts invalid config with fallback enabled returns standard TwiML', async () => {
    // When fallback is enabled and voiceId is missing, resolveVoiceQualityProfile
    // falls back to standard mode but retains validation errors.
    mockProfile = {
      mode: 'twilio_standard',
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      ttsProvider: 'Google',
      voice: 'Google.en-US-Journey-O',
      fallbackToStandardOnError: true,
      validationErrors: ['calls.voice.elevenlabs.voiceId is empty; falling back to twilio_standard'],
    };

    const session = createTestSession('conv-11labs-2', 'CA_11labs_2');
    const req = makeVoiceRequest(session.id, { CallSid: 'CA_11labs_2' });

    const res = await handleVoiceWebhook(req);

    expect(res.status).toBe(200);
    const twiml = await res.text();
    expect(twiml).toContain('ttsProvider="Google"');
    expect(twiml).toContain('<ConversationRelay');
    expect(twiml).toContain('voice="Google.en-US-Journey-O"');
  });

  // ── WS-B: elevenlabs_agent strict mode (fallback false) => 501 ─────
  test('elevenlabs_agent with fallback disabled returns 501', async () => {
    mockProfile = {
      mode: 'elevenlabs_agent',
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      ttsProvider: 'ElevenLabs',
      voice: 'voice123-turbo_v2_5-1_0.5_0.75',
      agentId: 'agent-abc',
      fallbackToStandardOnError: false,
      validationErrors: [],
    };

    const session = createTestSession('conv-11labs-3', 'CA_11labs_3');
    const req = makeVoiceRequest(session.id, { CallSid: 'CA_11labs_3' });

    const res = await handleVoiceWebhook(req);

    expect(res.status).toBe(501);
    const body = await res.text();
    expect(body).toContain('consultation bridging');
    expect(body).toContain('elevenlabs_agent mode is restricted');
  });

  // ── WS-B: elevenlabs_agent with fallback true => standard TwiML ────
  test('elevenlabs_agent with fallback enabled returns standard TwiML', async () => {
    // First call returns the elevenlabs_agent profile (triggers the guard)
    mockResolveVoiceQualityProfile.mockImplementationOnce(() => ({
      mode: 'elevenlabs_agent' as const,
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      ttsProvider: 'ElevenLabs',
      voice: 'voice123-turbo_v2_5-1_0.5_0.75',
      agentId: 'agent-abc',
      fallbackToStandardOnError: true,
      validationErrors: [],
    }));
    // Second call returns the standard profile (used for TwiML generation)
    mockResolveVoiceQualityProfile.mockImplementationOnce(() => ({
      mode: 'twilio_standard' as const,
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      ttsProvider: 'Google',
      voice: 'Google.en-US-Journey-O',
      fallbackToStandardOnError: true,
      validationErrors: [],
    }));

    const session = createTestSession('conv-11labs-4', 'CA_11labs_4');
    const req = makeVoiceRequest(session.id, { CallSid: 'CA_11labs_4' });

    const res = await handleVoiceWebhook(req);

    expect(res.status).toBe(200);
    const twiml = await res.text();
    // When elevenlabs_agent is guarded with fallback enabled, the handler
    // replaces the profile with a standard twilio_standard profile and
    // generates TwiML with Google TTS instead of ElevenLabs.
    expect(twiml).toContain('<ConversationRelay');
    expect(twiml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(twiml).toContain('<Response>');
    expect(twiml).toContain('<Connect>');
    expect(twiml).toContain('ttsProvider="Google"');
    expect(twiml).toContain('voice="Google.en-US-Journey-O"');
  });

  // ── Guard prevents register-call attempt ────────────────────────────
  test('guarded elevenlabs_agent does not attempt ElevenLabs register-call', async () => {
    // Configure as elevenlabs_agent with fallback (guard will fire)
    mockResolveVoiceQualityProfile.mockImplementationOnce(() => ({
      mode: 'elevenlabs_agent' as const,
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      ttsProvider: 'ElevenLabs',
      voice: 'voice123-turbo_v2_5-1_0.5_0.75',
      agentId: 'agent-abc',
      fallbackToStandardOnError: true,
      validationErrors: [],
    }));
    mockResolveVoiceQualityProfile.mockImplementationOnce(() => ({
      mode: 'twilio_standard' as const,
      language: 'en-US',
      transcriptionProvider: 'Deepgram',
      ttsProvider: 'Google',
      voice: 'Google.en-US-Journey-O',
      fallbackToStandardOnError: true,
      validationErrors: [],
    }));

    const session = createTestSession('conv-11labs-5', 'CA_11labs_5');
    const req = makeVoiceRequest(session.id, { CallSid: 'CA_11labs_5' });

    const res = await handleVoiceWebhook(req);

    expect(res.status).toBe(200);
    // The ElevenLabs register-call mock was never invoked — the guard
    // blocked the entire mode before any ElevenLabs API interaction.
    expect(mockRegisterCall).not.toHaveBeenCalled();
  });
});
