import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { homedir } from 'node:os';

describe('getSocketPath', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.VELLUM_DAEMON_SOCKET;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.VELLUM_DAEMON_SOCKET;
    } else {
      process.env.VELLUM_DAEMON_SOCKET = originalEnv;
    }
  });

  test('returns default path when no override is set', async () => {
    delete process.env.VELLUM_DAEMON_SOCKET;
    // Re-import to pick up env changes
    const { getSocketPath } = await import('../util/platform.js');
    expect(getSocketPath()).toBe(join(homedir(), '.vellum', 'vellum.sock'));
  });

  test('uses VELLUM_DAEMON_SOCKET when set', async () => {
    process.env.VELLUM_DAEMON_SOCKET = '/tmp/custom.sock';
    const { getSocketPath } = await import('../util/platform.js');
    expect(getSocketPath()).toBe('/tmp/custom.sock');
  });

  test('expands ~ in VELLUM_DAEMON_SOCKET', async () => {
    process.env.VELLUM_DAEMON_SOCKET = '~/my-sockets/vellum.sock';
    const { getSocketPath } = await import('../util/platform.js');
    expect(getSocketPath()).toBe(join(homedir(), 'my-sockets', 'vellum.sock'));
  });

  test('trims whitespace from VELLUM_DAEMON_SOCKET', async () => {
    process.env.VELLUM_DAEMON_SOCKET = '  /tmp/custom.sock  ';
    const { getSocketPath } = await import('../util/platform.js');
    expect(getSocketPath()).toBe('/tmp/custom.sock');
  });

  test('ignores empty VELLUM_DAEMON_SOCKET', async () => {
    process.env.VELLUM_DAEMON_SOCKET = '   ';
    const { getSocketPath } = await import('../util/platform.js');
    expect(getSocketPath()).toBe(join(homedir(), '.vellum', 'vellum.sock'));
  });
});
