import { describe, test, expect, mock } from 'bun:test';
import { RiskLevel } from '../permissions/types.js';

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

const { cliDiscoverTool } = await import('../tools/host-terminal/cli-discover.js');

const stubContext = {
  workingDir: '/tmp',
  sessionId: 'test',
  conversationId: 'test',
};

describe('cliDiscoverTool', () => {
  test('has correct metadata', () => {
    expect(cliDiscoverTool.name).toBe('cli_discover');
    expect(cliDiscoverTool.category).toBe('host-terminal');
    expect(cliDiscoverTool.defaultRiskLevel).toBe(RiskLevel.Low);
  });

  test('definition has expected schema', () => {
    const def = cliDiscoverTool.getDefinition();
    expect(def.name).toBe('cli_discover');
    expect(def.input_schema).toBeDefined();
    const props = (def.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props.names).toBeDefined();
    expect(props.check_auth).toBeDefined();
  });

  test('discovers git (universally available)', async () => {
    const result = await cliDiscoverTool.execute(
      { names: ['git'], check_auth: false },
      stubContext,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('**git**');
    expect(result.content).toContain('Available CLIs');
  });

  test('reports missing CLIs', async () => {
    const result = await cliDiscoverTool.execute(
      { names: ['__nonexistent_cli_xyz__'], check_auth: false },
      stubContext,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Not found');
    expect(result.content).toContain('__nonexistent_cli_xyz__');
  });

  test('handles mix of found and missing CLIs', async () => {
    const result = await cliDiscoverTool.execute(
      { names: ['git', '__nonexistent_cli_xyz__'], check_auth: false },
      stubContext,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Available CLIs');
    expect(result.content).toContain('**git**');
    expect(result.content).toContain('Not found');
    expect(result.content).toContain('__nonexistent_cli_xyz__');
  });

  test('uses default CLI list when names not provided', async () => {
    const result = await cliDiscoverTool.execute(
      { check_auth: false },
      stubContext,
    );
    expect(result.isError).toBe(false);
    // Should at least find git which is nearly universally available
    expect(result.content).toContain('**git**');
  }, 60_000);

  test('includes version info for found CLIs', async () => {
    const result = await cliDiscoverTool.execute(
      { names: ['git'], check_auth: false },
      stubContext,
    );
    expect(result.isError).toBe(false);
    // git --version outputs something like "git version 2.x.x"
    expect(result.content).toMatch(/git version/i);
  });
});
