import { describe, expect, mock, test } from 'bun:test';
import { realpathSync, mkdirSync, existsSync } from 'node:fs';

mock.module('../util/logger.js', () => ({
  getLogger: () => ({
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
}));

const { DockerBackend } = await import(
  '../tools/terminal/backends/docker.js'
);
const { ToolError } = await import('../util/errors.js');

// Use a real temp dir so realpathSync resolves correctly.
const sandboxRoot = realpathSync('/tmp');

describe('DockerBackend — argument construction', () => {
  const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);

  test('returns docker as the command', () => {
    const result = backend.wrap('echo hi', sandboxRoot);
    expect(result.command).toBe('docker');
  });

  test('sandboxed flag is always true', () => {
    const result = backend.wrap('pwd', sandboxRoot);
    expect(result.sandboxed).toBe(true);
  });

  test('uses --rm for ephemeral containers', () => {
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--rm');
  });

  test('drops all capabilities', () => {
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--cap-drop=ALL');
  });

  test('sets no-new-privileges security option', () => {
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--security-opt=no-new-privileges');
  });

  test('disables network by default', () => {
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--network=none');
  });

  test('applies default resource limits', () => {
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--cpus=2');
    expect(result.args).toContain('--memory=512m');
    expect(result.args).toContain('--pids-limit=256');
  });

  test('passes host UID:GID via --user', () => {
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--user');
    const userIdx = result.args.indexOf('--user');
    expect(result.args[userIdx + 1]).toBe('1000:1000');
  });

  test('bind-mounts sandbox root to /workspace', () => {
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('--mount');
    const mountIdx = result.args.indexOf('--mount');
    expect(result.args[mountIdx + 1]).toBe(
      `type=bind,src=${sandboxRoot},dst=/workspace`,
    );
  });

  test('uses default image ubuntu:22.04', () => {
    const result = backend.wrap('ls', sandboxRoot);
    expect(result.args).toContain('ubuntu:22.04');
  });

  test('wraps command with bash -c --', () => {
    const cmd = 'cat /etc/passwd | wc -l';
    const result = backend.wrap(cmd, sandboxRoot);
    const bashIdx = result.args.indexOf('bash');
    expect(bashIdx).toBeGreaterThan(0);
    expect(result.args.slice(bashIdx)).toEqual(['bash', '-c', '--', cmd]);
  });
});

describe('DockerBackend — path mapping', () => {
  const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);

  test('maps sandbox root to /workspace workdir', () => {
    const result = backend.wrap('pwd', sandboxRoot);
    const wdIdx = result.args.indexOf('--workdir');
    expect(result.args[wdIdx + 1]).toBe('/workspace');
  });

  test('maps subdirectory to /workspace/<subdir>', () => {
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
  const backend = new DockerBackend(sandboxRoot, undefined, 1000, 1000);

  test('throws ToolError when workdir is outside sandbox root', () => {
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
