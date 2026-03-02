import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Command } from 'commander';

import { loadRawConfig, saveRawConfig } from '../config/loader.js';
import type { McpConfig, McpServerConfig } from '../config/mcp-schema.js';
import { deleteMcpOAuthCredentials, McpOAuthProvider } from '../mcp/mcp-oauth-provider.js';
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
        process.exitCode = 1;
        return;
      }

      let transport: Record<string, unknown>;
      switch (opts.transportType) {
        case 'stdio':
          if (!opts.command) {
            log.error('--command is required for stdio transport');
            process.exitCode = 1;
            return;
          }
          transport = { type: 'stdio', command: opts.command, args: opts.args ?? [] };
          break;
        case 'sse':
        case 'streamable-http':
          if (!opts.url) {
            log.error(`--url is required for ${opts.transportType} transport`);
            process.exitCode = 1;
            return;
          }
          transport = { type: opts.transportType, url: opts.url };
          break;
        default:
          log.error(`Unknown transport type: ${opts.transportType}. Must be stdio, sse, or streamable-http`);
          process.exitCode = 1;
          return;
      }

      if (!['low', 'medium', 'high'].includes(opts.risk)) {
        log.error(`Invalid risk level: ${opts.risk}. Must be low, medium, or high`);
        process.exitCode = 1;
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

  mcp
    .command('auth <name>')
    .description('Authenticate with an MCP server via OAuth')
    .action(async (name: string) => {
      const raw = loadRawConfig();
      const mcpConfig = raw.mcp as Partial<McpConfig> | undefined;
      const servers = mcpConfig?.servers ?? {};
      const serverConfig = (servers as Record<string, McpServerConfig>)[name];

      if (!serverConfig) {
        log.error(`MCP server "${name}" not found. Add it first with: vellum mcp add`);
        process.exitCode = 1;
        return;
      }

      const transport = serverConfig.transport;
      if (transport.type !== 'sse' && transport.type !== 'streamable-http') {
        log.error(`OAuth is only supported for sse/streamable-http transports (server "${name}" uses ${transport.type})`);
        process.exitCode = 1;
        return;
      }

      const provider = new McpOAuthProvider(name, transport.url, /* interactive */ true);
      // Clear all stale credentials — the callback server uses a random port,
      // so any previously cached client_info/tokens have a mismatched redirect_uri.
      await provider.invalidateCredentials('all');
      const { codePromise } = await provider.startCallbackServer();

      const OAUTH_TIMEOUT_MS = 150_000; // 2.5 min for browser interaction
      const TransportClass = transport.type === 'sse' ? SSEClientTransport : StreamableHTTPClientTransport;
      const mcpTransport = new TransportClass(
        new URL(transport.url),
        {
          authProvider: provider,
          requestInit: transport.headers ? { headers: transport.headers } : undefined,
        },
      );

      const client = new Client({ name: 'vellum-assistant', version: '1.0.0' });

      try {
        // Try connecting — if tokens are already cached, this succeeds immediately
        await client.connect(mcpTransport);
        provider.stopCallbackServer();
        await client.close();
        log.info(`Server "${name}" is already authenticated.`);
        return;
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) {
          provider.stopCallbackServer();
          try { await client.close(); } catch { /* ignore */ }
          log.error(`Failed to connect to "${name}": ${err}`);
          process.exitCode = 1;
          return;
        }
      }

      // UnauthorizedError — browser was opened by redirectToAuthorization().
      // Wait for the user to complete the OAuth flow.
      log.info('Waiting for authorization in browser... (press Ctrl+C to cancel)');

      let code: string;
      try {
        code = await Promise.race([
          codePromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('OAuth authorization timed out after 2.5 minutes')), OAUTH_TIMEOUT_MS),
          ),
        ]);
      } catch (err) {
        provider.stopCallbackServer();
        try { await client.close(); } catch { /* ignore */ }
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('denied') || message.includes('cancelled')) {
          log.error(`Authorization cancelled for "${name}".`);
        } else if (message.includes('timed out')) {
          log.error(`Authorization timed out for "${name}". Try again with: vellum mcp auth ${name}`);
        } else {
          log.error(`Authorization failed for "${name}": ${message}`);
        }
        process.exitCode = 1;
        return;
      }

      log.info('Authorization received. Exchanging token...');

      // Exchange auth code for tokens
      try {
        await mcpTransport.finishAuth(code);
      } catch (err) {
        provider.stopCallbackServer();
        try { await client.close(); } catch { /* ignore */ }
        log.error(`Token exchange failed for "${name}": ${err}`);
        process.exitCode = 1;
        return;
      }

      // Clean up transport/client so the process can exit
      try { await client.close(); } catch { /* ignore */ }
      provider.stopCallbackServer();

      log.info(`Authentication successful for "${name}".`);
      log.info('Restart the daemon for changes to take effect: vellum daemon restart');
      process.exit(0);
    });

  mcp
    .command('remove <name>')
    .description('Remove an MCP server configuration')
    .action(async (name: string) => {
      const raw = loadRawConfig();
      const mcpConfig = raw.mcp as Record<string, unknown> | undefined;
      const servers = mcpConfig?.servers as Record<string, unknown> | undefined;

      if (!servers || !servers[name]) {
        log.error(`MCP server "${name}" not found.`);
        process.exitCode = 1;
        return;
      }

      // Best-effort cleanup of any OAuth credentials stored for this server
      const serverConfig = servers[name] as Record<string, unknown>;
      const transport = serverConfig?.transport as Record<string, unknown> | undefined;
      if (transport?.type === 'sse' || transport?.type === 'streamable-http') {
        try {
          await deleteMcpOAuthCredentials(name);
        } catch {
          // Ignore — credentials may not exist
        }
      }

      delete servers[name];
      saveRawConfig(raw);
      log.info(`Removed MCP server "${name}".`);
      log.info('Restart the daemon for changes to take effect: vellum daemon restart');
    });
}
