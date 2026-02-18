import { describe, test, expect, afterEach } from 'bun:test';
import {
  createSession,
  startSession,
  stopSession,
  getSessionEnv,
  getActiveSession,
  getSessionsForConversation,
  stopAllSessions,
} from '../tools/network/script-proxy/index.js';

afterEach(async () => {
  await stopAllSessions();
});

describe('session-manager', () => {
  const CONV_ID = 'conv-test-1';
  const CRED_IDS = ['cred-a', 'cred-b'];

  describe('createSession', () => {
    test('creates a session in starting status with no port', () => {
      const session = createSession(CONV_ID, CRED_IDS);
      expect(session.id).toBeTruthy();
      expect(session.conversationId).toBe(CONV_ID);
      expect(session.credentialIds).toEqual(CRED_IDS);
      expect(session.status).toBe('starting');
      expect(session.port).toBeNull();
      expect(session.createdAt).toBeInstanceOf(Date);
    });

    test('generates unique IDs', () => {
      const a = createSession(CONV_ID, CRED_IDS);
      const b = createSession(CONV_ID, CRED_IDS);
      expect(a.id).not.toBe(b.id);
    });

    test('enforces maxSessionsPerConversation', () => {
      createSession(CONV_ID, CRED_IDS, { maxSessionsPerConversation: 1 });
      expect(() =>
        createSession(CONV_ID, CRED_IDS, { maxSessionsPerConversation: 1 }),
      ).toThrow(/Max sessions/);
    });

    test('does not count stopped sessions toward the limit', async () => {
      const s = createSession(CONV_ID, CRED_IDS, { maxSessionsPerConversation: 1 });
      await startSession(s.id);
      await stopSession(s.id);
      // Should succeed because the first session is now stopped
      const s2 = createSession(CONV_ID, CRED_IDS, { maxSessionsPerConversation: 1 });
      expect(s2.id).toBeTruthy();
    });
  });

  describe('startSession', () => {
    test('starts listening on an ephemeral port', async () => {
      const session = createSession(CONV_ID, CRED_IDS);
      const started = await startSession(session.id);
      expect(started.status).toBe('active');
      expect(started.port).toBeGreaterThan(0);
    });

    test('throws when session does not exist', async () => {
      await expect(startSession('nonexistent')).rejects.toThrow(/not found/);
    });

    test('throws when session is not in starting status', async () => {
      const session = createSession(CONV_ID, CRED_IDS);
      await startSession(session.id);
      await expect(startSession(session.id)).rejects.toThrow(/expected starting/);
    });
  });

  describe('stopSession', () => {
    test('stops an active session', async () => {
      const session = createSession(CONV_ID, CRED_IDS);
      await startSession(session.id);
      await stopSession(session.id);

      const all = getSessionsForConversation(CONV_ID);
      const stopped = all.find((s) => s.id === session.id);
      expect(stopped?.status).toBe('stopped');
      expect(stopped?.port).toBeNull();
    });

    test('is idempotent for already-stopped sessions', async () => {
      const session = createSession(CONV_ID, CRED_IDS);
      await startSession(session.id);
      await stopSession(session.id);
      // Should not throw
      await stopSession(session.id);
    });

    test('throws for nonexistent session', async () => {
      await expect(stopSession('nonexistent')).rejects.toThrow(/not found/);
    });
  });

  describe('getSessionEnv', () => {
    test('returns proxy env vars for an active session', async () => {
      const session = createSession(CONV_ID, CRED_IDS);
      const started = await startSession(session.id);
      const env = getSessionEnv(session.id);

      expect(env.HTTP_PROXY).toBe(`http://127.0.0.1:${started.port}`);
      expect(env.HTTPS_PROXY).toBe(`http://127.0.0.1:${started.port}`);
      expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    });

    test('throws for inactive session', () => {
      const session = createSession(CONV_ID, CRED_IDS);
      expect(() => getSessionEnv(session.id)).toThrow(/not active/);
    });
  });

  describe('getActiveSession', () => {
    test('returns an active session for the conversation', async () => {
      const session = createSession(CONV_ID, CRED_IDS);
      await startSession(session.id);
      const active = getActiveSession(CONV_ID);
      expect(active).toBeDefined();
      expect(active!.id).toBe(session.id);
      expect(active!.status).toBe('active');
    });

    test('returns undefined when no active session exists', () => {
      expect(getActiveSession('nonexistent-conv')).toBeUndefined();
    });

    test('returns undefined after session is stopped', async () => {
      const session = createSession(CONV_ID, CRED_IDS);
      await startSession(session.id);
      await stopSession(session.id);
      expect(getActiveSession(CONV_ID)).toBeUndefined();
    });
  });

  describe('getSessionsForConversation', () => {
    test('returns all sessions for a conversation', async () => {
      createSession(CONV_ID, CRED_IDS);
      createSession(CONV_ID, ['cred-c']);
      const all = getSessionsForConversation(CONV_ID);
      expect(all).toHaveLength(2);
    });

    test('does not include sessions from other conversations', () => {
      createSession(CONV_ID, CRED_IDS);
      createSession('other-conv', CRED_IDS);
      const all = getSessionsForConversation(CONV_ID);
      expect(all).toHaveLength(1);
    });
  });

  describe('stopAllSessions', () => {
    test('stops all active sessions', async () => {
      const a = createSession(CONV_ID, CRED_IDS);
      const b = createSession('conv-2', CRED_IDS);
      await startSession(a.id);
      await startSession(b.id);

      await stopAllSessions();

      // After stopAll + clear, no sessions should exist
      expect(getActiveSession(CONV_ID)).toBeUndefined();
      expect(getActiveSession('conv-2')).toBeUndefined();
    });
  });

  describe('idle timeout', () => {
    test('auto-stops session after idle timeout', async () => {
      const session = createSession(CONV_ID, CRED_IDS, { idleTimeoutMs: 100 });
      await startSession(session.id);
      expect(getActiveSession(CONV_ID)).toBeDefined();

      // Wait for the idle timeout to fire
      await new Promise((r) => setTimeout(r, 200));

      expect(getActiveSession(CONV_ID)).toBeUndefined();
      const all = getSessionsForConversation(CONV_ID);
      const s = all.find((x) => x.id === session.id);
      expect(s?.status).toBe('stopped');
    });
  });
});
