import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { realpathSync, mkdirSync, existsSync } from 'node:fs';
import * as realChildProcess from 'node:child_process';

const execSyncMock = mock((_command: string, _opts?: unknown): unknown => undefined);

mock.module('node:child_process', () => ({
  ...realChildProcess,
  execSync: execSyncMock,
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
  // Default: all preflight checks pass.
  execSyncMock.mockImplementation(() => undefined);
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

  test('wraps command with bash -c --', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    const cmd = 'cat /etc/passwd | wc -l';
    const result = backend.wrap(cmd, sandboxRoot);
    const bashIdx = result.args.indexOf('bash');
    expect(bashIdx).toBeGreaterThan(0);
    expect(result.args.slice(bashIdx)).toEqual(['bash', '-c', '--', cmd]);
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
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('docker image inspect')) {
        throw new Error('No such image');
      }
      return undefined;
    });

    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    expect(() => backend.wrap('ls', sandboxRoot)).toThrow(ToolError);
    expect(() => backend.wrap('ls', sandboxRoot)).toThrow(
      'docker pull ubuntu:22.04',
    );
  });

  test('includes image name in error message', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('docker image inspect')) {
        throw new Error('No such image');
      }
      return undefined;
    });

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

  test('caches successful image check per image', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    backend.wrap('ls', sandboxRoot);
    backend.wrap('ls', sandboxRoot);

    const inspectCalls = execSyncMock.mock.calls.filter(
      (args) =>
        typeof args[0] === 'string' && args[0].includes('docker image inspect'),
    );
    expect(inspectCalls.length).toBe(1);
  });
});

describe('DockerBackend — preflight: mount probe', () => {
  test('throws ToolError with file sharing hint when mount fails', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('docker run --rm')) {
        throw new Error('mount failed');
      }
      return undefined;
    });

    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    expect(() => backend.wrap('ls', sandboxRoot)).toThrow(ToolError);
    expect(() => backend.wrap('ls', sandboxRoot)).toThrow(
      'File Sharing',
    );
  });

  test('includes sandbox root path in error message', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('docker run --rm')) {
        throw new Error('mount failed');
      }
      return undefined;
    });

    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    try {
      backend.wrap('ls', sandboxRoot);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      expect((err as Error).message).toContain(sandboxRoot);
    }
  });

  test('caches successful mount probe per sandbox root', () => {
    const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);
    backend.wrap('ls', sandboxRoot);
    backend.wrap('ls', sandboxRoot);

    const mountCalls = execSyncMock.mock.calls.filter(
      (args) =>
        typeof args[0] === 'string' && args[0].includes('docker run --rm'),
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
