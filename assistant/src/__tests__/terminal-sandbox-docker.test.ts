import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { realpathSync, mkdirSync, existsSync } from 'node:fs';
import * as realChildProcess from 'node:child_process';

const execSyncMock = mock((_command: string, _opts?: unknown): unknown => undefined);
const execFileSyncMock = mock(
  (_file: string, _args?: readonly string[], _opts?: unknown): unknown => undefined,
);

mock.module('node:child_process', () => ({
  ...realChildProcess,
  execSync: execSyncMock,
  execFileSync: execFileSyncMock,
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => ({
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
}));

const { DockerBackend, _resetDockerChecks } = await import(
  '../tools/terminal/backends/docker.js'
);
const { ToolError } = await import('../util/errors.js');

// Use a real temp dir so realpathSync resolves correctly.
const sandboxRoot = realpathSync('/tmp');

beforeEach(() => {
  _resetDockerChecks();
  execSyncMock.mockReset();
  execFileSyncMock.mockReset();
  // Default: all preflight checks pass.
  execSyncMock.mockImplementation(() => undefined);
  execFileSyncMock.mockImplementation(() => undefined);
});

describe('DockerBackend — argument construction', () => {
  test('returns docker as the command', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('echo hi', sandboxRoot);
    expect(result.command).toBe('docker');
  });

  test('sandboxed flag is always true', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('pwd', sandboxRoot);
    expect(result.sandboxed).toBe(true);
  });

  test('uses --rm for ephemeral containers', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--rm');
  });

  test('drops all capabilities', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--cap-drop=ALL');
  });

  test('sets no-new-privileges security option', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--security-opt=no-new-privileges');
  });

  test('disables network by default', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--network=none');
  });

  test('applies default resource limits', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--cpus=2');
    expect(result.args).toContain('--memory=512m');
    expect(result.args).toContain('--pids-limit=256');
  });

  test('passes host UID:GID via --user', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--user');
    const userIdx = result.args.indexOf('--user');
    expect(result.args[userIdx + 1]).toBe('1000:1000');
  });

  test('bind-mounts sandbox root to /workspace', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--mount');
    const mountIdx = result.args.indexOf('--mount');
    expect(result.args[mountIdx + 1]).toBe(
      `type=bind,src=${sandboxRoot},dst=/workspace`,
    );
  });

  test('uses default image ubuntu:22.04', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('ubuntu:22.04');
  });

  test('wraps command with sh -c -- by default', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const cmd = 'cat /etc/passwd | wc -l';
    const result = backend.wrap(cmd, sandboxRoot);
    const shIdx = result.args.indexOf('sh');
    expect(shIdx).toBeGreaterThan(0);
    expect(result.args.slice(shIdx)).toEqual(['sh', '-c', '--', cmd]);
  });
});

describe('DockerBackend — read-only root and tmpfs', () => {
  test('sets --read-only flag for container root filesystem', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--read-only');
  });

  test('mounts writable tmpfs at /tmp', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--tmpfs');
    const tmpfsIdx = result.args.indexOf('--tmpfs');
    expect(result.args[tmpfsIdx + 1]).toBe('/tmp:rw,nosuid,nodev,noexec');
  });

  test('--read-only appears before image name', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', sandboxRoot);
    const readOnlyIdx = result.args.indexOf('--read-only');
    const imageIdx = result.args.indexOf('ubuntu:22.04');
    expect(readOnlyIdx).toBeLessThan(imageIdx);
  });

  test('--tmpfs appears before image name', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', sandboxRoot);
    const tmpfsIdx = result.args.indexOf('--tmpfs');
    const imageIdx = result.args.indexOf('ubuntu:22.04');
    expect(tmpfsIdx).toBeLessThan(imageIdx);
  });
});

describe('DockerBackend — path mapping', () => {
  test('maps sandbox root to /workspace workdir', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('pwd', sandboxRoot);
    const wdIdx = result.args.indexOf('--workdir');
    expect(result.args[wdIdx + 1]).toBe('/workspace');
  });

  test('maps subdirectory to /workspace/<subdir>', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const subDir = `${sandboxRoot}/docker-sandbox-test-sub`;
    if (!existsSync(subDir)) {
      mkdirSync(subDir, { recursive: true });
    }
    const result = backend.wrap('pwd', subDir);
    const wdIdx = result.args.indexOf('--workdir');
    expect(result.args[wdIdx + 1]).toBe('/workspace/docker-sandbox-test-sub');
  });
});

describe('DockerBackend — fail-closed on escape', () => {
  test('throws ToolError when workdir is outside sandbox root', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    // /var is not under /tmp
    const outsideDir = realpathSync('/var');
    expect(() => backend.wrap('ls', outsideDir)).toThrow(ToolError);
    expect(() => backend.wrap('ls', outsideDir)).toThrow(
      'outside the sandbox root',
    );
  });

  test('error message does not leak host working directory path', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const outsideDir = realpathSync('/var');
    try {
      backend.wrap('ls', outsideDir);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      // Should NOT contain the actual host paths
      expect((err as Error).message).not.toContain(outsideDir);
      expect((err as Error).message).not.toContain(sandboxRoot);
    }
  });

  test('rejects path traversal via ../ in working directory', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const subDir = `${sandboxRoot}/docker-sandbox-test-sub`;
    if (!existsSync(subDir)) {
      mkdirSync(subDir, { recursive: true });
    }
    // ../../var should resolve outside sandbox root
    const traversalDir = `${subDir}/../../var`;
    expect(() => backend.wrap('ls', traversalDir)).toThrow(ToolError);
    expect(() => backend.wrap('ls', traversalDir)).toThrow(
      'outside the sandbox root',
    );
  });
});

describe('DockerBackend — special characters in paths', () => {
  test('handles spaces in sandbox root path', () => {
    const dirWithSpaces = `${sandboxRoot}/docker sandbox test spaces`;
    if (!existsSync(dirWithSpaces)) {
      mkdirSync(dirWithSpaces, { recursive: true });
    }
    const backend = new DockerBackend(dirWithSpaces, undefined, 1000, 1000);
    const result = backend.wrap('ls', dirWithSpaces);
    // Args are separate argv segments, so spaces are safe
    expect(result.args).toContain('--mount');
    const mountIdx = result.args.indexOf('--mount');
    expect(result.args[mountIdx + 1]).toContain(dirWithSpaces);
    expect(result.sandboxed).toBe(true);
  });

  test('handles quotes in working directory name', () => {
    const dirWithQuotes = `${sandboxRoot}/docker'sandbox"test`;
    if (!existsSync(dirWithQuotes)) {
      mkdirSync(dirWithQuotes, { recursive: true });
    }
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', dirWithQuotes);
    const wdIdx = result.args.indexOf('--workdir');
    expect(result.args[wdIdx + 1]).toContain("docker'sandbox\"test");
    expect(result.sandboxed).toBe(true);
  });

  test('handles dollar signs and backticks in paths', () => {
    const dirWithShellChars = `${sandboxRoot}/docker$sandbox\`test`;
    if (!existsSync(dirWithShellChars)) {
      mkdirSync(dirWithShellChars, { recursive: true });
    }
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', dirWithShellChars);
    // Because we use argv segments (not shell interpolation), these are safe
    expect(result.sandboxed).toBe(true);
  });
});

describe('DockerBackend — argv segment safety', () => {
  test('all args are discrete strings — no shell metacharacters are interpreted', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('echo $(whoami)', sandboxRoot);
    // The command is passed as a single argv element after '--'
    const dashDashIdx = result.args.indexOf('--');
    expect(dashDashIdx).toBeGreaterThan(0);
    expect(result.args[dashDashIdx + 1]).toBe('echo $(whoami)');
    // The command itself is a single string, not split by the shell
    expect(result.args.filter((a: string) => a === '$(whoami)').length).toBe(0);
  });

  test('every arg is a string type', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls -la', sandboxRoot);
    for (const arg of result.args) {
      expect(typeof arg).toBe('string');
    }
  });

  test('no arg contains unintended shell operators', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', sandboxRoot);
    // None of the docker flag args (before the image) should contain ; | && etc.
    const imageIdx = result.args.indexOf('ubuntu:22.04');
    const flagArgs = result.args.slice(0, imageIdx);
    for (const arg of flagArgs) {
      expect(arg).not.toContain(';');
      expect(arg).not.toContain('|');
      expect(arg).not.toContain('&&');
    }
  });
});

describe('DockerBackend — UID:GID mapping', () => {
  test('always includes --user flag with UID:GID', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 501, 20);
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--user');
    const userIdx = result.args.indexOf('--user');
    expect(result.args[userIdx + 1]).toBe('501:20');
  });

  test('defaults to process UID:GID when not specified', () => {
    const backend = new DockerBackend(sandboxRoot);
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--user');
    const userIdx = result.args.indexOf('--user');
    const expected = `${process.getuid!()}:${process.getgid!()}`;
    expect(result.args[userIdx + 1]).toBe(expected);
  });

  test('UID:GID format is always numeric colon-separated', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 0, 0);
    const result = backend.wrap('ls', sandboxRoot);
    const userIdx = result.args.indexOf('--user');
    expect(result.args[userIdx + 1]).toMatch(/^\d+:\d+$/);
  });
});

describe('DockerBackend — custom config', () => {
  test('accepts custom image', () => {
    const backend = new DockerBackend(
      sandboxRoot,
      { image: 'alpine:3.19' },
      1000,
      1000,
    );
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('alpine:3.19');
    expect(result.args).not.toContain('ubuntu:22.04');
  });

  test('accepts custom resource limits', () => {
    const backend = new DockerBackend(
      sandboxRoot,
      { cpus: 4, memoryMb: 1024, pidsLimit: 512 },
      1000,
      1000,
    );
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--cpus=4');
    expect(result.args).toContain('--memory=1024m');
    expect(result.args).toContain('--pids-limit=512');
  });

  test('accepts custom shell', () => {
    const backend = new DockerBackend(
      sandboxRoot,
      { shell: 'bash' },
      1000,
      1000,
    );
    const result = backend.wrap('echo hi', sandboxRoot);
    const bashIdx = result.args.indexOf('bash');
    expect(bashIdx).toBeGreaterThan(0);
    expect(result.args.slice(bashIdx)).toEqual(['bash', '-c', '--', 'echo hi']);
  });

  test('accepts custom network mode', () => {
    const backend = new DockerBackend(
      sandboxRoot,
      { network: 'bridge' },
      1000,
      1000,
    );
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--network=bridge');
  });
});

describe('DockerBackend — preflight: Docker CLI check', () => {
  test('throws ToolError with install hint when docker CLI is missing', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('docker')) {
        throw new Error('command not found: docker');
      }
      return undefined;
    });

    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    expect(() => backend.wrap('ls', sandboxRoot)).toThrow(ToolError);
    expect(() => backend.wrap('ls', sandboxRoot)).toThrow(
      'Docker CLI is not installed',
    );
  });

  test('caches successful CLI check', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    backend.wrap('ls', sandboxRoot);
    backend.wrap('ls', sandboxRoot);

    // docker --version should only be called once (cached after success).
    const versionCalls = execSyncMock.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0] === 'docker --version',
    );
    expect(versionCalls.length).toBe(1);
  });
});

describe('DockerBackend — preflight: Docker daemon check', () => {
  test('throws ToolError with start hint when daemon is unreachable', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd === 'docker info') {
        throw new Error('Cannot connect to the Docker daemon');
      }
      return undefined;
    });

    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    expect(() => backend.wrap('ls', sandboxRoot)).toThrow(ToolError);
    expect(() => backend.wrap('ls', sandboxRoot)).toThrow(
      'Docker daemon is not running',
    );
  });

  test('caches successful daemon check', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    backend.wrap('ls', sandboxRoot);
    backend.wrap('ls', sandboxRoot);

    const infoCalls = execSyncMock.mock.calls.filter(
      (args) => typeof args[0] === 'string' && args[0] === 'docker info',
    );
    expect(infoCalls.length).toBe(1);
  });
});

describe('DockerBackend — preflight: image availability check', () => {
  test('throws ToolError with pull hint when image is missing', () => {
    // Image check now uses execFileSync instead of execSync.
    execFileSyncMock.mockImplementation(
      (file: string, args?: readonly string[]) => {
        if (
          file === 'docker' &&
          Array.isArray(args) &&
          args.includes('inspect')
        ) {
          throw new Error('No such image');
        }
        return undefined;
      },
    );

    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    expect(() => backend.wrap('ls', sandboxRoot)).toThrow(ToolError);
    expect(() => backend.wrap('ls', sandboxRoot)).toThrow(
      'docker pull ubuntu:22.04',
    );
  });

  test('includes image name in error message', () => {
    execFileSyncMock.mockImplementation(
      (file: string, args?: readonly string[]) => {
        if (
          file === 'docker' &&
          Array.isArray(args) &&
          args.includes('inspect')
        ) {
          throw new Error('No such image');
        }
        return undefined;
      },
    );

    const backend = new DockerBackend(
      sandboxRoot,
      { image: 'alpine:3.19' },
      1000,
      1000,
    );
    try {
      backend.wrap('ls', sandboxRoot);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as Error).message).toContain('alpine:3.19');
    }
  });

  test('uses execFileSync (not execSync) for image check — no shell interpolation', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    backend.wrap('ls', sandboxRoot);

    // execFileSync should have been called with 'docker' and argv array
    const imageCalls = execFileSyncMock.mock.calls.filter(
      (args) =>
        args[0] === 'docker' &&
        Array.isArray(args[1]) &&
        (args[1] as string[]).includes('inspect'),
    );
    expect(imageCalls.length).toBe(1);
    // Verify the image name is a separate argv element, not interpolated into a string
    const argv = imageCalls[0]![1] as string[];
    expect(argv).toContain('image');
    expect(argv).toContain('inspect');
    expect(argv).toContain('ubuntu:22.04');
  });

  test('caches successful image check per image', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    backend.wrap('ls', sandboxRoot);
    backend.wrap('ls', sandboxRoot);

    const inspectCalls = execFileSyncMock.mock.calls.filter(
      (args) =>
        args[0] === 'docker' &&
        Array.isArray(args[1]) &&
        (args[1] as string[]).includes('inspect'),
    );
    expect(inspectCalls.length).toBe(1);
  });
});

describe('DockerBackend — preflight: mount probe', () => {
  test('throws ToolError with file sharing hint when mount fails', () => {
    // Mount probe now uses execFileSync.
    execFileSyncMock.mockImplementation(
      (file: string, args?: readonly string[]) => {
        if (
          file === 'docker' &&
          Array.isArray(args) &&
          args.includes('run')
        ) {
          throw new Error('mount failed');
        }
        return undefined;
      },
    );

    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    expect(() => backend.wrap('ls', sandboxRoot)).toThrow(ToolError);
    expect(() => backend.wrap('ls', sandboxRoot)).toThrow(
      'File Sharing',
    );
  });

  test('mount probe error does not leak host sandbox root path', () => {
    execFileSyncMock.mockImplementation(
      (file: string, args?: readonly string[]) => {
        if (
          file === 'docker' &&
          Array.isArray(args) &&
          args.includes('run')
        ) {
          throw new Error('mount failed');
        }
        return undefined;
      },
    );

    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    try {
      backend.wrap('ls', sandboxRoot);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      // Error message should be generic, not revealing the host path
      expect((err as Error).message).not.toContain(sandboxRoot);
    }
  });

  test('uses execFileSync (not execSync) for mount probe — no shell interpolation', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    backend.wrap('ls', sandboxRoot);

    const mountCalls = execFileSyncMock.mock.calls.filter(
      (args) =>
        args[0] === 'docker' &&
        Array.isArray(args[1]) &&
        (args[1] as string[]).includes('run'),
    );
    expect(mountCalls.length).toBe(1);
    // Verify mount arg is passed as a single argv element
    const argv = mountCalls[0]![1] as string[];
    expect(argv).toContain('--rm');
    expect(argv).toContain('--mount');
  });

  test('caches successful mount probe per sandbox root', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    backend.wrap('ls', sandboxRoot);
    backend.wrap('ls', sandboxRoot);

    const mountCalls = execFileSyncMock.mock.calls.filter(
      (args) =>
        args[0] === 'docker' &&
        Array.isArray(args[1]) &&
        (args[1] as string[]).includes('run'),
    );
    expect(mountCalls.length).toBe(1);
  });
});

describe('DockerBackend — preflight check order', () => {
  test('checks CLI before daemon', () => {
    // All docker commands fail, but we expect the CLI error first.
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('docker')) {
        throw new Error('docker not available');
      }
      return undefined;
    });

    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    try {
      backend.wrap('ls', sandboxRoot);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as Error).message).toContain('Docker CLI is not installed');
    }
  });

  test('does not retry positive checks on subsequent calls', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    // First call succeeds and caches all checks.
    backend.wrap('ls', sandboxRoot);

    // Now make all docker commands fail.
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('docker')) {
        throw new Error('docker unavailable');
      }
      return undefined;
    });
    execFileSyncMock.mockImplementation(
      (file: string) => {
        if (file === 'docker') {
          throw new Error('docker unavailable');
        }
        return undefined;
      },
    );

    // Should still succeed — all checks are cached.
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.command).toBe('docker');
    expect(result.sandboxed).toBe(true);
  });

  test('re-checks negative results on subsequent calls', () => {
    // Start with CLI failing.
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd === 'docker --version') {
        throw new Error('not found');
      }
      return undefined;
    });

    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    expect(() => backend.wrap('ls', sandboxRoot)).toThrow(
      'Docker CLI is not installed',
    );

    // Now make it succeed.
    execSyncMock.mockImplementation(() => undefined);
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.command).toBe('docker');
  });
});

describe('DockerBackend — no unsandboxed fallback', () => {
  test('wrap never returns sandboxed=false', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.sandboxed).toBe(true);
  });

  test('preflight failure always throws, never returns unsandboxed result', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('docker')) {
        throw new Error('not available');
      }
      return undefined;
    });

    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    let threw = false;
    try {
      backend.wrap('ls', sandboxRoot);
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(ToolError);
    }
    expect(threw).toBe(true);
  });
});

describe('DockerBackend — complete hardening profile verification', () => {
  test('all security flags are present in correct order before image', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const result = backend.wrap('ls', sandboxRoot);
    const imageIdx = result.args.indexOf('ubuntu:22.04');

    // All of these must appear before the image name
    const securityFlags = [
      '--network=none',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--read-only',
    ];
    for (const flag of securityFlags) {
      const idx = result.args.indexOf(flag);
      expect(idx).toBeGreaterThan(-1);
      expect(idx).toBeLessThan(imageIdx);
    }
  });

  test('resource limits are all applied', () => {
    const backend = new DockerBackend(
      sandboxRoot,
      { cpus: 1, memoryMb: 256, pidsLimit: 64 },
      1000,
      1000,
    );
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--cpus=1');
    expect(result.args).toContain('--memory=256m');
    expect(result.args).toContain('--pids-limit=64');
  });
});
