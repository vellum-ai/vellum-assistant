import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Mock the credential metadata store so the Telegram adapter can resolve
// the bot username without touching the filesystem.
let mockBotUsername: string | undefined = 'test_invite_bot';
mock.module('../tools/credentials/metadata-store.js', () => ({
  getCredentialMetadata: (service: string, field: string) => {
    if (service === 'telegram' && field === 'bot_token' && mockBotUsername) {
      return { accountInfo: mockBotUsername };
    }
    return undefined;
  },
  upsertCredentialMetadata: () => {},
  deleteCredentialMetadata: () => {},
  listCredentialMetadata: () => [],
}));

import {
  _resetRegistry,
  type ChannelInviteTransport,
  getTransport,
  registerTransport,
} from '../runtime/channel-invite-transport.js';
// Importing the Telegram module auto-registers the transport
import { telegramInviteTransport } from '../runtime/channel-invite-transports/telegram.js';

describe('channel-invite-transport', () => {
  beforeEach(() => {
    _resetRegistry();
    mockBotUsername = 'test_invite_bot';
    // Re-register after reset so Telegram tests work
    registerTransport(telegramInviteTransport);
  });

  // =========================================================================
  // Registry
  // =========================================================================

  describe('registry', () => {
    test('returns the Telegram transport for telegram channel', () => {
      const transport = getTransport('telegram');
      expect(transport).toBeDefined();
      expect(transport!.channel).toBe('telegram');
    });

    test('returns undefined for an unregistered channel', () => {
      const transport = getTransport('sms');
      expect(transport).toBeUndefined();
    });

    test('overwrites a previously registered transport for the same channel', () => {
      const custom: ChannelInviteTransport = {
        channel: 'telegram',
        buildShareableInvite: () => ({ url: 'custom', displayText: 'custom' }),
        extractInboundToken: () => undefined,
      };
      registerTransport(custom);
      const transport = getTransport('telegram');
      expect(transport!.buildShareableInvite({ rawToken: 'x', sourceChannel: 'telegram' }).url).toBe('custom');
    });

    test('_resetRegistry clears all transports', () => {
      _resetRegistry();
      expect(getTransport('telegram')).toBeUndefined();
    });
  });

  // =========================================================================
  // Telegram adapter — buildShareableInvite
  // =========================================================================

  describe('telegram buildShareableInvite', () => {
    test('produces a valid Telegram deep link', () => {
      const result = telegramInviteTransport.buildShareableInvite({
        rawToken: 'abc123_test-token',
        sourceChannel: 'telegram',
      });

      expect(result.url).toBe('https://t.me/test_invite_bot?start=iv_abc123_test-token');
      expect(result.displayText).toContain('https://t.me/test_invite_bot?start=iv_abc123_test-token');
    });

    test('deep link is deterministic for the same token', () => {
      const a = telegramInviteTransport.buildShareableInvite({ rawToken: 'tok1', sourceChannel: 'telegram' });
      const b = telegramInviteTransport.buildShareableInvite({ rawToken: 'tok1', sourceChannel: 'telegram' });
      expect(a.url).toBe(b.url);
      expect(a.displayText).toBe(b.displayText);
    });

    test('uses the configured bot username', () => {
      mockBotUsername = 'my_custom_bot';
      const result = telegramInviteTransport.buildShareableInvite({
        rawToken: 'token',
        sourceChannel: 'telegram',
      });
      expect(result.url).toBe('https://t.me/my_custom_bot?start=iv_token');
    });

    test('throws when bot username is not configured', () => {
      mockBotUsername = undefined;
      // Also clear the env var to ensure no fallback
      const prev = process.env.TELEGRAM_BOT_USERNAME;
      delete process.env.TELEGRAM_BOT_USERNAME;
      try {
        expect(() =>
          telegramInviteTransport.buildShareableInvite({
            rawToken: 'token',
            sourceChannel: 'telegram',
          }),
        ).toThrow('bot username is not configured');
      } finally {
        if (prev !== undefined) process.env.TELEGRAM_BOT_USERNAME = prev;
      }
    });

    test('falls back to TELEGRAM_BOT_USERNAME env var', () => {
      mockBotUsername = undefined;
      const prev = process.env.TELEGRAM_BOT_USERNAME;
      process.env.TELEGRAM_BOT_USERNAME = 'env_bot';
      try {
        const result = telegramInviteTransport.buildShareableInvite({
          rawToken: 'token',
          sourceChannel: 'telegram',
        });
        expect(result.url).toBe('https://t.me/env_bot?start=iv_token');
      } finally {
        if (prev !== undefined) {
          process.env.TELEGRAM_BOT_USERNAME = prev;
        } else {
          delete process.env.TELEGRAM_BOT_USERNAME;
        }
      }
    });
  });

  // =========================================================================
  // Telegram adapter — extractInboundToken
  // =========================================================================

  describe('telegram extractInboundToken', () => {
    test('extracts token from structured commandIntent', () => {
      const token = telegramInviteTransport.extractInboundToken({
        commandIntent: { type: 'start', payload: 'iv_abc123' },
        content: '/start iv_abc123',
      });
      expect(token).toBe('abc123');
    });

    test('extracts base64url token from commandIntent', () => {
      const token = telegramInviteTransport.extractInboundToken({
        commandIntent: { type: 'start', payload: 'iv_YWJjMTIz-_test' },
        content: '/start iv_YWJjMTIz-_test',
      });
      expect(token).toBe('YWJjMTIz-_test');
    });

    test('returns undefined when commandIntent has no payload', () => {
      const token = telegramInviteTransport.extractInboundToken({
        commandIntent: { type: 'start' },
        content: '/start',
      });
      expect(token).toBeUndefined();
    });

    test('returns undefined when commandIntent payload has wrong prefix (gv_)', () => {
      const token = telegramInviteTransport.extractInboundToken({
        commandIntent: { type: 'start', payload: 'gv_abc123' },
        content: '/start gv_abc123',
      });
      expect(token).toBeUndefined();
    });

    test('returns undefined when commandIntent payload has no prefix', () => {
      const token = telegramInviteTransport.extractInboundToken({
        commandIntent: { type: 'start', payload: 'abc123' },
        content: '/start abc123',
      });
      expect(token).toBeUndefined();
    });

    test('returns undefined when commandIntent type is not start', () => {
      const token = telegramInviteTransport.extractInboundToken({
        commandIntent: { type: 'help', payload: 'iv_abc123' },
        content: '/help iv_abc123',
      });
      expect(token).toBeUndefined();
    });

    test('returns undefined when commandIntent payload is iv_ with empty token', () => {
      const token = telegramInviteTransport.extractInboundToken({
        commandIntent: { type: 'start', payload: 'iv_' },
        content: '/start iv_',
      });
      expect(token).toBeUndefined();
    });

    test('returns undefined when commandIntent payload is iv_ with whitespace-only token', () => {
      const token = telegramInviteTransport.extractInboundToken({
        commandIntent: { type: 'start', payload: 'iv_   ' },
        content: '/start iv_   ',
      });
      expect(token).toBeUndefined();
    });

    test('extracts token from raw content fallback', () => {
      const token = telegramInviteTransport.extractInboundToken({
        content: '/start iv_abc123',
      });
      expect(token).toBe('abc123');
    });

    test('extracts token from raw content with extra whitespace', () => {
      const token = telegramInviteTransport.extractInboundToken({
        content: '/start   iv_token123',
      });
      expect(token).toBe('token123');
    });

    test('returns undefined for empty content', () => {
      const token = telegramInviteTransport.extractInboundToken({
        content: '',
      });
      expect(token).toBeUndefined();
    });

    test('returns undefined for content without /start', () => {
      const token = telegramInviteTransport.extractInboundToken({
        content: 'hello world',
      });
      expect(token).toBeUndefined();
    });

    test('returns undefined for /start without iv_ prefix in content', () => {
      const token = telegramInviteTransport.extractInboundToken({
        content: '/start gv_abc123',
      });
      expect(token).toBeUndefined();
    });

    test('returns undefined for malformed /start with only iv_ in content', () => {
      const token = telegramInviteTransport.extractInboundToken({
        content: '/start iv_',
      });
      expect(token).toBeUndefined();
    });

    test('prefers commandIntent over raw content', () => {
      const token = telegramInviteTransport.extractInboundToken({
        commandIntent: { type: 'start', payload: 'iv_from_intent' },
        content: '/start iv_from_content',
      });
      expect(token).toBe('from_intent');
    });

    test('returns undefined when commandIntent rejects, even if content has token', () => {
      // commandIntent present but payload has wrong prefix
      const token = telegramInviteTransport.extractInboundToken({
        commandIntent: { type: 'start', payload: 'gv_abc123' },
        content: '/start iv_valid_token',
      });
      expect(token).toBeUndefined();
    });
  });
});
