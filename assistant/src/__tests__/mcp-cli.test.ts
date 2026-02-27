import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

const CLI = join(import.meta.dir, '..', 'index.ts');

let testDataDir: string;
let configPath: string;

function runMcpList(args: string[] = []): { stdout: string; exitCode: number } {
  const result = spawnSync('bun', ['run', CLI, 'mcp', 'list', ...args], {
    encoding: 'utf-8',
    timeout: 10_000,
    env: { ...process.env, BASE_DATA_DIR: testDataDir },
  });
  return {
    stdout: (result.stdout ?? '').toString(),
    exitCode: result.status ?? 1,
  };
}

function writeConfig(config: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify(config), 'utf-8');
}

describe('vellum mcp list', () => {
  beforeAll(() => {
    testDataDir = join(tmpdir(), `vellum-mcp-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const workspaceDir = join(testDataDir, '.vellum', 'workspace');
    mkdirSync(workspaceDir, { recursive: true });
    configPath = join(workspaceDir, 'config.json');
    writeConfig({});
  });

  afterAll(() => {
    rmSync(testDataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    writeConfig({});
  });

  test('shows message when no MCP servers configured', () => {
    const { stdout, exitCode } = runMcpList();
    expect(exitCode).toBe(0);
    expect(stdout).toContain('No MCP servers configured');
  });

  test('lists configured servers', () => {
    writeConfig({
      mcp: {
        servers: {
          'test-server': {
            transport: { type: 'streamable-http', url: 'https://example.com/mcp' },
            enabled: true,
            defaultRiskLevel: 'medium',
          },
        },
      },
    });

    const { stdout, exitCode } = runMcpList();
    expect(exitCode).toBe(0);
    expect(stdout).toContain('1 MCP server(s) configured');
    expect(stdout).toContain('test-server');
    expect(stdout).toContain('streamable-http');
    expect(stdout).toContain('https://example.com/mcp');
    expect(stdout).toContain('medium');
  });

  test('shows disabled status', () => {
    writeConfig({
      mcp: {
        servers: {
          'disabled-server': {
            transport: { type: 'sse', url: 'https://example.com/sse' },
            enabled: false,
            defaultRiskLevel: 'high',
          },
        },
      },
    });

    const { stdout, exitCode } = runMcpList();
    expect(exitCode).toBe(0);
    expect(stdout).toContain('disabled');
  });

  test('shows stdio command info', () => {
    writeConfig({
      mcp: {
        servers: {
          'stdio-server': {
            transport: { type: 'stdio', command: 'npx', args: ['-y', 'some-mcp-server'] },
            enabled: true,
            defaultRiskLevel: 'low',
          },
        },
      },
    });

    const { stdout, exitCode } = runMcpList();
    expect(exitCode).toBe(0);
    expect(stdout).toContain('stdio-server');
    expect(stdout).toContain('stdio');
    expect(stdout).toContain('npx -y some-mcp-server');
    expect(stdout).toContain('low');
  });

  test('--json outputs valid JSON', () => {
    writeConfig({
      mcp: {
        servers: {
          'json-server': {
            transport: { type: 'streamable-http', url: 'https://example.com/mcp' },
            enabled: true,
            defaultRiskLevel: 'high',
          },
        },
      },
    });

    const { stdout, exitCode } = runMcpList(['--json']);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('json-server');
    expect(parsed[0].transport.url).toBe('https://example.com/mcp');
  });

  test('--json outputs empty array when no servers', () => {
    const { stdout, exitCode } = runMcpList(['--json']);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toEqual([]);
  });
});
