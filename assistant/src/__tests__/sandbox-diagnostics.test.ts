import { beforeEach, describe, expect, mock, test } from 'bun:test';
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

// Mock platform detection — default to macOS
let mockIsMacOS = true;
let mockIsLinux = false;

mock.module('../util/platform.js', () => ({
  isMacOS: () => mockIsMacOS,
  isLinux: () => mockIsLinux,
  getRootDir: () => '/tmp/vellum-test',
  getDataDir: () => '/tmp/vellum-test/data',
  getSocketPath: () => '/tmp/vellum-test/vellum.sock',
  getDbPath: () => '/tmp/vellum-test/data/db/assistant.db',
  getLogPath: () => '/tmp/vellum-test/data/logs/daemon.log',
  getSandboxRootDir: () => '/tmp/vellum-test/sandbox',
  getSandboxWorkingDir: () => '/tmp/vellum-test/sandbox/workspace',
  ensureDataDir: () => {},
  getHistoryPath: () => '/tmp/vellum-test/data/history',
  getHooksDir: () => '/tmp/vellum-test/hooks',
  getPidPath: () => '/tmp/vellum-test/data/daemon.pid',
}));

// Mock config loader — return a config with sandbox settings
let mockSandboxConfig = {
  enabled: true,
  backend: 'native' as const,
  docker: {
    image: 'node:20-slim',
    cpus: 1,
    memoryMb: 512,
    pidsLimit: 256,
    network: 'none' as const,
  },
};

mock.module('../config/loader.js', () => ({
  getConfig: () => ({
    sandbox: mockSandboxConfig,
  }),
  loadRawConfig: () => ({}),
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => ({
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
}));

const { runSandboxDiagnostics } = await import(
  '../tools/terminal/sandbox-diagnostics.js'
);

beforeEach(() => {
  execSyncMock.mockReset();
  execFileSyncMock.mockReset();
  mockIsMacOS = true;
  mockIsLinux = false;
  mockSandboxConfig = {
    enabled: true,
    backend: 'native',
    docker: {
      image: 'node:20-slim',
      cpus: 1,
      memoryMb: 512,
      pidsLimit: 256,
      network: 'none',
    },
  };
  // Default: all commands succeed. execSync with encoding returns a string,
  // so we must return a string to avoid .trim() throwing on undefined.
  execSyncMock.mockImplementation(() => 'Docker version 24.0.7, build afdd53b');
  execFileSyncMock.mockImplementation(() => 'ok\n');
});

describe('runSandboxDiagnostics — config reporting', () => {
  test('reports sandbox enabled state', () => {
    const result = runSandboxDiagnostics();
    expect(result.config.enabled).toBe(true);
  });

  test('reports sandbox disabled state', () => {
    mockSandboxConfig.enabled = false;
    const result = runSandboxDiagnostics();
    expect(result.config.enabled).toBe(false);
  });

  test('reports configured backend', () => {
    const result = runSandboxDiagnostics();
    expect(result.config.backend).toBe('native');
  });

  test('reports docker backend when configured', () => {
    mockSandboxConfig.backend = 'docker';
    const result = runSandboxDiagnostics();
    expect(result.config.backend).toBe('docker');
  });

  test('reports docker image', () => {
    const result = runSandboxDiagnostics();
    expect(result.config.dockerImage).toBe('node:20-slim');
  });
});

describe('runSandboxDiagnostics — active backend reason', () => {
  test('explains native backend selection', () => {
    const result = runSandboxDiagnostics();
    expect(result.activeBackendReason).toContain('Native backend');
  });

  test('explains docker backend selection', () => {
    mockSandboxConfig.backend = 'docker';
    const result = runSandboxDiagnostics();
    expect(result.activeBackendReason).toContain('Docker backend');
  });

  test('explains when sandbox is disabled', () => {
    mockSandboxConfig.enabled = false;
    const result = runSandboxDiagnostics();
    expect(result.activeBackendReason).toContain('disabled');
  });
});

describe('runSandboxDiagnostics — native backend check (macOS)', () => {
  test('passes when sandbox-exec works on macOS', () => {
    const result = runSandboxDiagnostics();
    const nativeCheck = result.checks.find((c) => c.label.includes('Native sandbox'));
    expect(nativeCheck).toBeDefined();
    expect(nativeCheck!.ok).toBe(true);
    expect(nativeCheck!.label).toContain('macOS');
  });

  test('fails when sandbox-exec does not work on macOS', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('sandbox-exec')) {
        throw new Error('not available');
      }
      return 'Docker version 24.0.7';
    });
    const result = runSandboxDiagnostics();
    const nativeCheck = result.checks.find((c) => c.label.includes('Native sandbox'));
    expect(nativeCheck).toBeDefined();
    expect(nativeCheck!.ok).toBe(false);
  });
});

describe('runSandboxDiagnostics — native backend check (Linux)', () => {
  test('passes when bwrap works on Linux', () => {
    mockIsMacOS = false;
    mockIsLinux = true;
    const result = runSandboxDiagnostics();
    const nativeCheck = result.checks.find((c) => c.label.includes('Native sandbox'));
    expect(nativeCheck).toBeDefined();
    expect(nativeCheck!.ok).toBe(true);
    expect(nativeCheck!.label).toContain('Linux');
  });

  test('fails when bwrap is not available on Linux', () => {
    mockIsMacOS = false;
    mockIsLinux = true;
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('bwrap')) {
        throw new Error('not found');
      }
      return 'Docker version 24.0.7';
    });
    const result = runSandboxDiagnostics();
    const nativeCheck = result.checks.find((c) => c.label.includes('Native sandbox'));
    expect(nativeCheck).toBeDefined();
    expect(nativeCheck!.ok).toBe(false);
    expect(nativeCheck!.detail).toContain('bubblewrap');
  });
});

describe('runSandboxDiagnostics — native backend check (unsupported OS)', () => {
  test('reports unsupported when neither macOS nor Linux', () => {
    mockIsMacOS = false;
    mockIsLinux = false;
    const result = runSandboxDiagnostics();
    const nativeCheck = result.checks.find((c) => c.label.includes('Native sandbox'));
    expect(nativeCheck).toBeDefined();
    expect(nativeCheck!.ok).toBe(false);
    expect(nativeCheck!.detail).toContain('not supported');
  });
});

describe('runSandboxDiagnostics — Docker CLI check', () => {
  test('passes when docker CLI is available', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd === 'docker --version') {
        return 'Docker version 24.0.7, build afdd53b';
      }
      return undefined;
    });
    const result = runSandboxDiagnostics();
    const cliCheck = result.checks.find((c) => c.label === 'Docker CLI installed');
    expect(cliCheck).toBeDefined();
    expect(cliCheck!.ok).toBe(true);
    expect(cliCheck!.detail).toContain('Docker version');
  });

  test('fails when docker CLI is not found', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd === 'docker --version') {
        throw new Error('command not found: docker');
      }
      return undefined;
    });
    const result = runSandboxDiagnostics();
    const cliCheck = result.checks.find((c) => c.label === 'Docker CLI installed');
    expect(cliCheck).toBeDefined();
    expect(cliCheck!.ok).toBe(false);
    expect(cliCheck!.detail).toContain('not found');
  });
});

describe('runSandboxDiagnostics — Docker daemon check', () => {
  test('passes when daemon is reachable', () => {
    const result = runSandboxDiagnostics();
    const daemonCheck = result.checks.find((c) => c.label === 'Docker daemon running');
    expect(daemonCheck).toBeDefined();
    expect(daemonCheck!.ok).toBe(true);
  });

  test('fails when daemon is not running', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd === 'docker info') {
        throw new Error('Cannot connect to the Docker daemon');
      }
      return 'Docker version 24.0.7';
    });
    const result = runSandboxDiagnostics();
    const daemonCheck = result.checks.find((c) => c.label === 'Docker daemon running');
    expect(daemonCheck).toBeDefined();
    expect(daemonCheck!.ok).toBe(false);
  });

  test('skipped when CLI is not available', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('docker')) {
        throw new Error('command not found');
      }
      return undefined;
    });
    const result = runSandboxDiagnostics();
    const daemonCheck = result.checks.find((c) => c.label === 'Docker daemon running');
    expect(daemonCheck).toBeUndefined();
  });
});

describe('runSandboxDiagnostics — Docker image check', () => {
  test('passes when image is available locally', () => {
    const result = runSandboxDiagnostics();
    const imageCheck = result.checks.find((c) => c.label.includes('Docker image available'));
    expect(imageCheck).toBeDefined();
    expect(imageCheck!.ok).toBe(true);
  });

  test('fails when image is not available', () => {
    execFileSyncMock.mockImplementation(
      (file: string, args?: readonly string[]) => {
        if (file === 'docker' && Array.isArray(args) && args.includes('inspect')) {
          throw new Error('No such image');
        }
        return 'ok\n';
      },
    );
    const result = runSandboxDiagnostics();
    const imageCheck = result.checks.find((c) => c.label.includes('Docker image available'));
    expect(imageCheck).toBeDefined();
    expect(imageCheck!.ok).toBe(false);
    expect(imageCheck!.detail).toContain('docker pull');
  });

  test('includes configured image name in label', () => {
    mockSandboxConfig.docker.image = 'alpine:3.19';
    const result = runSandboxDiagnostics();
    const imageCheck = result.checks.find((c) => c.label.includes('Docker image available'));
    expect(imageCheck).toBeDefined();
    expect(imageCheck!.label).toContain('alpine:3.19');
  });

  test('skipped when daemon is not running', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd === 'docker info') {
        throw new Error('Cannot connect');
      }
      return 'Docker version 24.0.7';
    });
    const result = runSandboxDiagnostics();
    const imageCheck = result.checks.find((c) => c.label.includes('Docker image available'));
    expect(imageCheck).toBeUndefined();
  });
});

describe('runSandboxDiagnostics — Docker container execution check', () => {
  test('passes when container runs successfully', () => {
    const result = runSandboxDiagnostics();
    const runCheck = result.checks.find((c) => c.label === 'Docker container execution');
    expect(runCheck).toBeDefined();
    expect(runCheck!.ok).toBe(true);
  });

  test('fails when container execution errors', () => {
    execFileSyncMock.mockImplementation(
      (file: string, args?: readonly string[]) => {
        if (file === 'docker' && Array.isArray(args) && args.includes('run')) {
          throw new Error('container failed');
        }
        return 'ok\n';
      },
    );
    const result = runSandboxDiagnostics();
    const runCheck = result.checks.find((c) => c.label === 'Docker container execution');
    expect(runCheck).toBeDefined();
    expect(runCheck!.ok).toBe(false);
  });

  test('fails when container output is unexpected', () => {
    execFileSyncMock.mockImplementation(
      (file: string, args?: readonly string[]) => {
        if (file === 'docker' && Array.isArray(args) && args.includes('run')) {
          return 'unexpected\n';
        }
        return 'ok\n';
      },
    );
    const result = runSandboxDiagnostics();
    const runCheck = result.checks.find((c) => c.label === 'Docker container execution');
    expect(runCheck).toBeDefined();
    expect(runCheck!.ok).toBe(false);
    expect(runCheck!.detail).toContain('unexpected');
  });

  test('skipped when daemon is not running', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd === 'docker info') {
        throw new Error('Cannot connect');
      }
      return 'Docker version 24.0.7';
    });
    const result = runSandboxDiagnostics();
    const runCheck = result.checks.find((c) => c.label === 'Docker container execution');
    expect(runCheck).toBeUndefined();
  });
});

describe('runSandboxDiagnostics — check cascade', () => {
  test('Docker daemon, image, and run checks are skipped when CLI is missing', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('docker')) {
        throw new Error('not found');
      }
      return undefined;
    });
    const result = runSandboxDiagnostics();
    const labels = result.checks.map((c) => c.label);
    expect(labels).toContain('Docker CLI installed');
    expect(labels).not.toContain('Docker daemon running');
    expect(labels.find((l) => l.includes('Docker image'))).toBeUndefined();
    expect(labels).not.toContain('Docker container execution');
  });

  test('image and run checks are skipped when daemon is down', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd === 'docker info') {
        throw new Error('Cannot connect');
      }
      return 'Docker version 24.0.7';
    });
    const result = runSandboxDiagnostics();
    const labels = result.checks.map((c) => c.label);
    expect(labels).toContain('Docker CLI installed');
    expect(labels).toContain('Docker daemon running');
    expect(labels.find((l) => l.includes('Docker image'))).toBeUndefined();
    expect(labels).not.toContain('Docker container execution');
  });

  test('all Docker checks run when everything works', () => {
    const result = runSandboxDiagnostics();
    const labels = result.checks.map((c) => c.label);
    expect(labels).toContain('Docker CLI installed');
    expect(labels).toContain('Docker daemon running');
    expect(labels.find((l) => l.includes('Docker image'))).toBeDefined();
    expect(labels).toContain('Docker container execution');
  });
});
