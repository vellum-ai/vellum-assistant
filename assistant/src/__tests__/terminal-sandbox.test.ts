import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realChildProcess from 'node:child_process';
import * as realFs from 'node:fs';
import type { SandboxConfig } from '../config/schema.js';

let platform = 'linux';

const execSyncMock = mock((_command: string): unknown => {
  throw new Error('bwrap unavailable');
});

mock.module('../util/platform.js', () => ({
  isMacOS: () => platform === 'darwin',
  isLinux: () => platform === 'linux',
  getSandboxWorkingDir: () => '/tmp/sandbox/fs',
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

const writeFileSyncMock = mock((..._args: unknown[]) => {});
const existsSyncMock = mock((_path: string) => true);
const mkdirSyncMock = mock((..._args: unknown[]) => {});

mock.module('node:fs', () => ({
  ...realFs,
  writeFileSync: writeFileSyncMock,
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
}));

const { wrapCommand } = await import('../tools/terminal/sandbox.js');
const { ToolError } = await import('../util/errors.js');

const defaultDocker = { image: 'node:20-slim', shell: 'bash', cpus: 1, memoryMb: 512, pidsLimit: 256, network: 'none' as const };

function disabledConfig(): SandboxConfig {
  return { enabled: false, backend: 'native', docker: defaultDocker };
}

function nativeConfig(): SandboxConfig {
  return { enabled: true, backend: 'native', docker: defaultDocker };
}

describe('terminal sandbox — disabled behavior', () => {
  beforeEach(() => {
    platform = 'linux';
  });

  test('returns unsandboxed bash -c wrapper when disabled', () => {
    const result = wrapCommand('pwd', '/tmp', disabledConfig());
    expect(result).toEqual({
      command: 'bash',
      args: ['-c', '--', 'pwd'],
      sandboxed: false,
    });
  });

  test('sandboxed flag is false when disabled regardless of platform', () => {
    for (const p of ['linux', 'darwin', 'win32']) {
      platform = p;
      const result = wrapCommand('echo hi', '/tmp', disabledConfig());
      expect(result.sandboxed).toBe(false);
      expect(result.command).toBe('bash');
    }
  });

  test('preserves the original command string in args when disabled', () => {
    const cmd = 'cat /etc/passwd | wc -l';
    const result = wrapCommand(cmd, '/home/user', disabledConfig());
    expect(result.args).toEqual(['-c', '--', cmd]);
  });
});

describe('terminal sandbox — enabled fail-closed behavior', () => {
  beforeEach(() => {
    platform = 'linux';
    execSyncMock.mockImplementation((_command: string) => {
      throw new Error('bwrap unavailable');
    });
  });

  test('throws ToolError when bwrap is unavailable on linux', () => {
    expect(() => wrapCommand('echo hello', '/tmp', nativeConfig())).toThrow(ToolError);
    expect(() => wrapCommand('echo hello', '/tmp', nativeConfig())).toThrow(
      'Sandbox is enabled but bwrap is not available or cannot create namespaces.',
    );
  });

  test('returns bwrap wrapper when bwrap is available on linux', () => {
    execSyncMock.mockImplementation(() => undefined);
    const result = wrapCommand('echo hello', '/home/user/project', nativeConfig());
    expect(result.command).toBe('bwrap');
    expect(result.sandboxed).toBe(true);
    expect(result.args).toContain('--ro-bind');
    expect(result.args).toContain('--unshare-net');
    expect(result.args).toContain('--unshare-pid');
    // The user command runs via bash inside the sandbox
    const bashIdx = result.args.indexOf('bash');
    expect(bashIdx).toBeGreaterThan(0);
    expect(result.args.slice(bashIdx)).toEqual(['bash', '-c', '--', 'echo hello']);
  });

  test('bind-mounts working directory read-write in bwrap args', () => {
    execSyncMock.mockImplementation(() => undefined);
    const workDir = '/home/user/my-project';
    const result = wrapCommand('ls', workDir, nativeConfig());
    // The args should contain --bind workDir workDir for read-write access
    const bindIdx = result.args.indexOf('--bind');
    expect(bindIdx).toBeGreaterThan(-1);
    expect(result.args[bindIdx + 1]).toBe(workDir);
    expect(result.args[bindIdx + 2]).toBe(workDir);
  });
});

describe('terminal sandbox — unsupported platform fail-closed behavior', () => {
  test('throws ToolError on unsupported platforms when enabled', () => {
    platform = 'win32';
    expect(() => wrapCommand('pwd', '/tmp', nativeConfig())).toThrow(ToolError);
    expect(() => wrapCommand('pwd', '/tmp', nativeConfig())).toThrow(
      'Sandbox is enabled but not supported on this platform (',
    );
  });

  test('error message includes refusing to execute unsandboxed', () => {
    platform = 'win32';
    try {
      wrapCommand('pwd', '/tmp', nativeConfig());
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as Error).message).toContain('Refusing to execute unsandboxed');
    }
  });
});

describe('terminal sandbox — macOS sandbox-exec behavior', () => {
  beforeEach(() => {
    platform = 'darwin';
    writeFileSyncMock.mockClear();
    existsSyncMock.mockImplementation(() => true);
  });

  test('returns sandbox-exec wrapper on macOS when enabled', () => {
    const result = wrapCommand('echo hello', '/tmp/project', nativeConfig());
    expect(result.command).toBe('sandbox-exec');
    expect(result.sandboxed).toBe(true);
    expect(result.args[0]).toBe('-f');
    // Profile path is the second arg
    expect(result.args[1]).toContain('sandbox-profile-');
    // bash -c -- command follows the profile
    expect(result.args.slice(2)).toEqual(['bash', '-c', '--', 'echo hello']);
  });

  test('throws ToolError for working dirs with SBPL metacharacters', () => {
    expect(() => wrapCommand('pwd', '/tmp/bad"dir', nativeConfig())).toThrow(ToolError);
    expect(() => wrapCommand('pwd', '/tmp/bad(dir', nativeConfig())).toThrow(ToolError);
    expect(() => wrapCommand('pwd', '/tmp/bad;dir', nativeConfig())).toThrow(ToolError);
  });

  test('SBPL metacharacter error mentions unsafe characters', () => {
    try {
      wrapCommand('pwd', '/tmp/bad"dir', nativeConfig());
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as Error).message).toContain('SBPL metacharacters');
    }
  });
});

describe('terminal sandbox — backend selection', () => {
  beforeEach(() => {
    platform = 'darwin';
    writeFileSyncMock.mockClear();
    existsSyncMock.mockImplementation(() => true);
  });

  test('uses native backend when backend is "native"', () => {
    const result = wrapCommand('echo hello', '/tmp/project', nativeConfig());
    expect(result.command).toBe('sandbox-exec');
    expect(result.sandboxed).toBe(true);
  });

  test('disabled config ignores backend setting', () => {
    const config: SandboxConfig = { enabled: false, backend: 'docker', docker: defaultDocker };
    const result = wrapCommand('echo hello', '/tmp/project', config);
    expect(result.command).toBe('bash');
    expect(result.sandboxed).toBe(false);
  });
});
