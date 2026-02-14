import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realChildProcess from 'node:child_process';

let platform = 'linux';

const execSyncMock = mock((_command: string) => {
  throw new Error('bwrap unavailable');
});

mock.module('../util/platform.js', () => ({
  isMacOS: () => platform === 'darwin',
  isLinux: () => platform === 'linux',
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => ({
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
}));

mock.module('node:child_process', () => ({
  ...realChildProcess,
  execSync: execSyncMock,
}));

const { wrapCommand } = await import('../tools/terminal/sandbox.js');
const { ToolError } = await import('../util/errors.js');

describe('terminal sandbox fail-closed behavior', () => {
  beforeEach(() => {
    platform = 'linux';
    execSyncMock.mockImplementation((_command: string) => {
      throw new Error('bwrap unavailable');
    });
  });

  test('throws when sandbox is enabled and bwrap is unavailable on linux', () => {
    expect(() => wrapCommand('echo hello', '/tmp', true)).toThrow(ToolError);
    expect(() => wrapCommand('echo hello', '/tmp', true)).toThrow(
      'Sandbox is enabled but bwrap is not available or cannot create namespaces.',
    );
  });

  test('enabled=false still returns unsandboxed bash command', () => {
    const wrapped = wrapCommand('pwd', '/tmp', false);
    expect(wrapped).toEqual({
      command: 'bash',
      args: ['-c', '--', 'pwd'],
      sandboxed: false,
    });
  });

  test('throws when sandbox is enabled on unsupported platforms', () => {
    platform = 'win32';
    expect(() => wrapCommand('pwd', '/tmp', true)).toThrow(ToolError);
    expect(() => wrapCommand('pwd', '/tmp', true)).toThrow(
      'Sandbox is enabled but not supported on this platform (',
    );
  });
});
