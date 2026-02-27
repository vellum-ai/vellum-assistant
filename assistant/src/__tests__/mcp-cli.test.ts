import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { loadRawConfig, saveRawConfig } from '../config/loader.js';

const CLI = join(import.meta.dir, '..', 'index.ts');

function runMcpList(args: string[] = []): { stdout: string; exitCode: number } {
  const result = spawnSync('bun', ['run', CLI, 'mcp', 'list', ...args], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  return {
    stdout: (result.stdout ?? '').toString(),
    exitCode: result.status ?? 1,
  };
}

describe('vellum mcp list', () => {
  let originalConfig: Record<string, unknown>;

  beforeAll(() => {
    originalConfig = loadRawConfig();
  });

  afterAll(() => {
    saveRawConfig(originalConfig);
  });

  test('shows message when no MCP servers configured', () => {
    const raw = loadRawConfig();
    const savedMcp = raw.mcp;
    delete raw.mcp;
    saveRawConfig(raw);

    try {
      const { stdout, exitCode } = runMcpList();
      expect(exitCode).toBe(0);
      expect(stdout).toContain('No MCP servers configured');
    } finally {
      raw.mcp = savedMcp;
      saveRawConfig(raw);
    }
  });

  test('lists configured servers', () => {
    const raw = loadRawConfig();
    const savedMcp = raw.mcp;
    raw.mcp = {
      servers: {
        'test-server': {
          transport: { type: 'streamable-http', url: 'https://example.com/mcp' },
          enabled: true,
          defaultRiskLevel: 'medium',
        },
      },
    };
    saveRawConfig(raw);

    try {
      const { stdout, exitCode } = runMcpList();
      expect(exitCode).toBe(0);
      expect(stdout).toContain('1 MCP server(s) configured');
      expect(stdout).toContain('test-server');
      expect(stdout).toContain('streamable-http');
      expect(stdout).toContain('https://example.com/mcp');
      expect(stdout).toContain('medium');
    } finally {
      raw.mcp = savedMcp;
      saveRawConfig(raw);
    }
  });

  test('shows disabled status', () => {
    const raw = loadRawConfig();
    const savedMcp = raw.mcp;
    raw.mcp = {
      servers: {
        'disabled-server': {
          transport: { type: 'sse', url: 'https://example.com/sse' },
          enabled: false,
          defaultRiskLevel: 'high',
        },
      },
    };
    saveRawConfig(raw);

    try {
      const { stdout, exitCode } = runMcpList();
      expect(exitCode).toBe(0);
      expect(stdout).toContain('disabled');
    } finally {
      raw.mcp = savedMcp;
      saveRawConfig(raw);
    }
  });

  test('shows stdio command info', () => {
    const raw = loadRawConfig();
    const savedMcp = raw.mcp;
    raw.mcp = {
      servers: {
        'stdio-server': {
          transport: { type: 'stdio', command: 'npx', args: ['-y', 'some-mcp-server'] },
          enabled: true,
          defaultRiskLevel: 'low',
        },
      },
    };
    saveRawConfig(raw);

    try {
      const { stdout, exitCode } = runMcpList();
      expect(exitCode).toBe(0);
      expect(stdout).toContain('stdio-server');
      expect(stdout).toContain('stdio');
      expect(stdout).toContain('npx -y some-mcp-server');
      expect(stdout).toContain('low');
    } finally {
      raw.mcp = savedMcp;
      saveRawConfig(raw);
    }
  });

  test('--json outputs valid JSON', () => {
    const raw = loadRawConfig();
    const savedMcp = raw.mcp;
    raw.mcp = {
      servers: {
        'json-server': {
          transport: { type: 'streamable-http', url: 'https://example.com/mcp' },
          enabled: true,
          defaultRiskLevel: 'high',
        },
      },
    };
    saveRawConfig(raw);

    try {
      const { stdout, exitCode } = runMcpList(['--json']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].id).toBe('json-server');
      expect(parsed[0].transport.url).toBe('https://example.com/mcp');
    } finally {
      raw.mcp = savedMcp;
      saveRawConfig(raw);
    }
  });

  test('--json outputs empty array when no servers', () => {
    const raw = loadRawConfig();
    const savedMcp = raw.mcp;
    delete raw.mcp;
    saveRawConfig(raw);

    try {
      const { stdout, exitCode } = runMcpList(['--json']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toEqual([]);
    } finally {
      raw.mcp = savedMcp;
      saveRawConfig(raw);
    }
  });
});
