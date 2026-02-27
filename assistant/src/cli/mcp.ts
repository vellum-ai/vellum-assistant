import type { Command } from 'commander';

import { loadRawConfig, saveRawConfig } from '../config/loader.js';
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
        const result = entries
          .filter(([, config]) => config && typeof config === 'object')
          .map(([id, config]) => ({ id, ...config }));
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }

      log.info(`${entries.length} MCP server(s) configured:\n`);
      for (const [id, cfg] of entries) {
        if (!cfg || typeof cfg !== 'object') {
          log.info(`  ${id} (invalid config — skipped)\n`);
          continue;
        }
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

  mcp
    .command('add <name>')
    .description('Add an MCP server configuration')
    .requiredOption('-t, --transport-type <type>', 'Transport type: stdio, sse, or streamable-http')
    .option('-u, --url <url>', 'Server URL (for sse/streamable-http)')
    .option('-c, --command <cmd>', 'Command to run (for stdio)')
    .option('-a, --args <args...>', 'Command arguments (for stdio)')
    .option('-r, --risk <level>', 'Default risk level: low, medium, or high', 'high')
    .option('--disabled', 'Add as disabled')
    .action((name: string, opts: {
      transportType: string;
      url?: string;
      command?: string;
      args?: string[];
      risk: string;
      disabled?: boolean;
    }) => {
      const raw = loadRawConfig();
      if (!raw.mcp) raw.mcp = { servers: {} };
      const mcpConfig = raw.mcp as Record<string, unknown>;
      if (!mcpConfig.servers) mcpConfig.servers = {};
      const servers = mcpConfig.servers as Record<string, unknown>;

      if (servers[name]) {
        log.error(`MCP server "${name}" already exists. Remove it first with: vellum mcp remove ${name}`);
        return;
      }

      let transport: Record<string, unknown>;
      switch (opts.transportType) {
        case 'stdio':
          if (!opts.command) {
            log.error('--command is required for stdio transport');
            return;
          }
          transport = { type: 'stdio', command: opts.command, args: opts.args ?? [] };
          break;
        case 'sse':
        case 'streamable-http':
          if (!opts.url) {
            log.error(`--url is required for ${opts.transportType} transport`);
            return;
          }
          transport = { type: opts.transportType, url: opts.url };
          break;
        default:
          log.error(`Unknown transport type: ${opts.transportType}. Must be stdio, sse, or streamable-http`);
          return;
      }

      if (!['low', 'medium', 'high'].includes(opts.risk)) {
        log.error(`Invalid risk level: ${opts.risk}. Must be low, medium, or high`);
        return;
      }

      servers[name] = {
        transport,
        enabled: !opts.disabled,
        defaultRiskLevel: opts.risk,
      };

      saveRawConfig(raw);
      log.info(`Added MCP server "${name}" (${opts.transportType})`);
      log.info('Restart the daemon for changes to take effect: vellum daemon restart');
    });
}
