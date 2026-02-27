import type { Command } from 'commander';

import { loadRawConfig } from '../config/loader.js';
import type { McpConfig, McpServerConfig } from '../config/mcp-schema.js';
import { getCliLogger } from '../util/logger.js';

const log = getCliLogger('cli');

export function registerMcpCommand(program: Command): void {
  const mcp = program.command('mcp').description('Manage MCP (Model Context Protocol) servers');

  mcp
    .command('list')
    .description('List configured MCP servers and their status')
    .option('--json', 'Output as JSON')
    .action((opts: { json?: boolean }) => {
      const raw = loadRawConfig();
      const mcpConfig = raw.mcp as Partial<McpConfig> | undefined;
      const servers = mcpConfig?.servers ?? {};
      const entries = Object.entries(servers) as [string, McpServerConfig][];

      if (entries.length === 0) {
        if (opts.json) {
          process.stdout.write(JSON.stringify([], null, 2) + '\n');
        } else {
          log.info('No MCP servers configured.');
        }
        return;
      }

      if (opts.json) {
        const result = entries.map(([id, config]) => ({ id, ...config }));
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }

      log.info(`${entries.length} MCP server(s) configured:\n`);
      for (const [id, cfg] of entries) {
        const enabled = cfg.enabled !== false;
        const transport = cfg.transport;
        const risk = cfg.defaultRiskLevel ?? 'high';
        const status = enabled ? '✓ enabled' : '✗ disabled';

        log.info(`  ${id}`);
        log.info(`    Status:    ${status}`);
        log.info(`    Transport: ${transport?.type ?? 'unknown'}`);
        if (transport?.type === 'stdio') {
          log.info(`    Command:   ${transport.command} ${(transport.args ?? []).join(' ')}`);
        } else if (transport && 'url' in transport) {
          log.info(`    URL:       ${transport.url}`);
        }
        log.info(`    Risk:      ${risk}`);
        if (cfg.allowedTools) log.info(`    Allowed:   ${cfg.allowedTools.join(', ')}`);
        if (cfg.blockedTools) log.info(`    Blocked:   ${cfg.blockedTools.join(', ')}`);
        log.info('');
      }
    });
}
