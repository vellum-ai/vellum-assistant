/**
 * Runtime-gated Docker integration tests.
 *
 * These tests run real Docker containers — they are skipped automatically
 * when Docker is not available or the sandbox image is not pulled locally.
 * To run them locally:
 *   1. Install Docker Desktop / Docker Engine
 *   2. docker pull <configured sandbox image>
 *   3. bun test src/__tests__/terminal-sandbox.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, execSync as _execSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getSandboxWorkingDir } from '../util/platform.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';

// ---------------------------------------------------------------------------
// Runtime gate: skip entire file if Docker is not usable
// ---------------------------------------------------------------------------

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

const IMAGE = DEFAULT_CONFIG.sandbox.docker.image;

function imageAvailable(): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', IMAGE], {
      stdio: 'ignore',
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

const DOCKER_OK = dockerAvailable() && imageAvailable();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sandboxRoot: string;

beforeAll(() => {
  if (!DOCKER_OK) return;
  const parent = getSandboxWorkingDir();
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  sandboxRoot = realpathSync(mkdtempSync(join(parent, 'docker-integ-')));
});

afterAll(() => {
  if (sandboxRoot && existsSync(sandboxRoot)) {
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

interface DockerRunOptions {
  /** Run as root instead of the host UID:GID. Useful for testing filesystem-level protections. */
  asRoot?: boolean;
}

/** Run a command inside a Docker container with the sandbox root mounted. */
function dockerRun(cmd: string, opts?: DockerRunOptions): { stdout: string; exitCode: number } {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const userArgs = opts?.asRoot ? ['--user', '0:0'] : ['--user', `${uid}:${gid}`];
  const result = spawnSync('docker', [
    'run', '--rm',
    '--network=none',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec',
    '--mount', `type=bind,src=${sandboxRoot},dst=/workspace`,
    '--workdir', '/workspace',
    ...userArgs,
    IMAGE,
    'bash', '-c', cmd,
  ], { timeout: 30000, encoding: 'utf-8' });
  return {
    stdout: (result.stdout ?? '').trim(),
    exitCode: result.status ?? -1,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!DOCKER_OK)('Docker integration: write inside sandbox', () => {
  test('writing a file inside /workspace succeeds', () => {
    const { exitCode } = dockerRun('echo "hello" > /workspace/test-write.txt && cat /workspace/test-write.txt');
    expect(exitCode).toBe(0);
    // Verify the file appeared on the host
    const hostPath = join(sandboxRoot, 'test-write.txt');
    expect(existsSync(hostPath)).toBe(true);
    expect(readFileSync(hostPath, 'utf-8').trim()).toBe('hello');
  });

  test('creating nested directories inside /workspace succeeds', () => {
    const { exitCode, stdout } = dockerRun('mkdir -p /workspace/a/b/c && echo ok');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('ok');
    expect(existsSync(join(sandboxRoot, 'a/b/c'))).toBe(true);
  });
});

describe.skipIf(!DOCKER_OK)('Docker integration: write outside workspace fails', () => {
  // Run as root so Unix permissions are not a factor — the read-only
  // filesystem mount is the only thing preventing these writes.
  test('writing to /etc inside container fails (read-only root)', () => {
    const { exitCode } = dockerRun('touch /etc/evil 2>/dev/null', { asRoot: true });
    expect(exitCode).not.toBe(0);
  });

  test('writing to /home inside container fails (read-only root)', () => {
    const { exitCode } = dockerRun('touch /home/evil 2>/dev/null', { asRoot: true });
    expect(exitCode).not.toBe(0);
  });

  test('writing to /tmp succeeds (tmpfs mount)', () => {
    // /tmp is an explicit tmpfs mount so writes should work
    const { exitCode, stdout } = dockerRun('echo ok > /tmp/test.txt && cat /tmp/test.txt');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('ok');
  });
});

describe.skipIf(!DOCKER_OK)('Docker integration: host-writable files', () => {
  test('files created in container are owned by host UID:GID', () => {
    const filename = 'host-owner-test.txt';
    dockerRun(`echo "owned" > /workspace/${filename}`);
    const hostPath = join(sandboxRoot, filename);
    expect(existsSync(hostPath)).toBe(true);
    const stat = statSync(hostPath);
    const expectedUid = process.getuid?.() ?? 1000;
    const expectedGid = process.getgid?.() ?? 1000;
    expect(stat.uid).toBe(expectedUid);
    expect(stat.gid).toBe(expectedGid);
  });

  test('host can read files created by container', () => {
    const filename = 'host-readable-test.txt';
    const content = 'container-created-content';
    dockerRun(`echo "${content}" > /workspace/${filename}`);
    const hostPath = join(sandboxRoot, filename);
    expect(readFileSync(hostPath, 'utf-8').trim()).toBe(content);
  });

  test('container can read files created by host', () => {
    const filename = 'host-created.txt';
    writeFileSync(join(sandboxRoot, filename), 'from-host');
    const { stdout, exitCode } = dockerRun(`cat /workspace/${filename}`);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('from-host');
  });
});
