import { describe, test, expect } from 'bun:test';
import { hasSocketOverride, shouldAutoStartDaemon } from '../daemon/connection-policy.js';

describe('hasSocketOverride', () => {
  test('returns false when VELLUM_DAEMON_SOCKET is not set', () => {
    expect(hasSocketOverride({})).toBe(false);
  });

  test('returns false when VELLUM_DAEMON_SOCKET is empty', () => {
    expect(hasSocketOverride({ VELLUM_DAEMON_SOCKET: '' })).toBe(false);
  });

  test('returns false when VELLUM_DAEMON_SOCKET is whitespace', () => {
    expect(hasSocketOverride({ VELLUM_DAEMON_SOCKET: '   ' })).toBe(false);
  });

  test('returns true when VELLUM_DAEMON_SOCKET is set', () => {
    expect(hasSocketOverride({ VELLUM_DAEMON_SOCKET: '/tmp/custom.sock' })).toBe(true);
  });
});

describe('shouldAutoStartDaemon', () => {
  test('returns true by default (no env vars set)', () => {
    expect(shouldAutoStartDaemon({})).toBe(true);
  });

  test('returns false when socket override is set', () => {
    expect(shouldAutoStartDaemon({ VELLUM_DAEMON_SOCKET: '/tmp/custom.sock' })).toBe(false);
  });

  test('returns true when socket override + VELLUM_DAEMON_AUTOSTART=1', () => {
    expect(shouldAutoStartDaemon({
      VELLUM_DAEMON_SOCKET: '/tmp/custom.sock',
      VELLUM_DAEMON_AUTOSTART: '1',
    })).toBe(true);
  });

  test('returns true when VELLUM_DAEMON_AUTOSTART=true', () => {
    expect(shouldAutoStartDaemon({
      VELLUM_DAEMON_SOCKET: '/tmp/custom.sock',
      VELLUM_DAEMON_AUTOSTART: 'true',
    })).toBe(true);
  });

  test('returns false when VELLUM_DAEMON_AUTOSTART=0', () => {
    expect(shouldAutoStartDaemon({ VELLUM_DAEMON_AUTOSTART: '0' })).toBe(false);
  });

  test('returns false when VELLUM_DAEMON_AUTOSTART=false', () => {
    expect(shouldAutoStartDaemon({ VELLUM_DAEMON_AUTOSTART: 'false' })).toBe(false);
  });

  test('autostart flag takes precedence over socket override', () => {
    // Explicit autostart=0 disables even without socket override
    expect(shouldAutoStartDaemon({ VELLUM_DAEMON_AUTOSTART: '0' })).toBe(false);
    // Explicit autostart=1 enables even with socket override
    expect(shouldAutoStartDaemon({
      VELLUM_DAEMON_SOCKET: '/tmp/custom.sock',
      VELLUM_DAEMON_AUTOSTART: '1',
    })).toBe(true);
  });
});
