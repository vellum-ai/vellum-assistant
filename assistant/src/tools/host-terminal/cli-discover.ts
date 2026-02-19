import { spawn } from 'node:child_process';
import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { getLogger } from '../../util/logger.js';
import { truncate } from '../../util/truncate.js';

const log = getLogger('cli-discover');

/**
 * Common business CLIs checked when no explicit list is provided.
 * Kept intentionally broad — the tool only reports what's on PATH.
 */
const DEFAULT_CLIS = [
  // Version control & code hosting
  'gh', 'git', 'gitlab',
  // Project management
  'linear', 'jira',
  // Communication
  'slack',
  // Cloud providers
  'aws', 'gcloud', 'az',
  // Containers & infra
  'docker', 'kubectl', 'terraform',
  // Package managers / runtimes
  'node', 'bun', 'deno', 'python3', 'pip3',
  // HTTP clients
  'curl', 'httpie',
  // Misc dev tools
  'vercel', 'netlify', 'fly', 'heroku', 'railway',
] as const;

/**
 * Known auth-check commands. Each entry maps a CLI binary name to the
 * command + args that report authentication status without side effects.
 */
const AUTH_CHECK_COMMANDS: Record<string, string[]> = {
  gh: ['gh', 'auth', 'status'],
  aws: ['aws', 'sts', 'get-caller-identity'],
  gcloud: ['gcloud', 'auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'],
  az: ['az', 'account', 'show'],
  vercel: ['vercel', 'whoami'],
  netlify: ['netlify', 'status'],
  fly: ['fly', 'auth', 'whoami'],
  heroku: ['heroku', 'auth:whoami'],
  railway: ['railway', 'whoami'],
};

interface CliResult {
  name: string;
  found: boolean;
  path?: string;
  version?: string;
  authenticated?: boolean;
  authInfo?: string;
}

/**
 * Run a command with a short timeout and return stdout (trimmed) or null on failure.
 */
function runQuick(command: string, args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    child.stdout.on('data', (data: Buffer) => chunks.push(data));

    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString().trim());
      } else {
        resolve(null);
      }
    });

    child.on('error', () => resolve(null));
  });
}

class CliDiscoverTool implements Tool {
  name = 'cli_discover';
  description = 'Discover which CLI tools are installed, their versions, and authentication status';
  category = 'host-terminal';
  defaultRiskLevel = RiskLevel.Low;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            description: 'CLI binary names to check. Defaults to a broad set of common business CLIs if omitted.',
          },
          check_auth: {
            type: 'boolean',
            description: 'Whether to run auth-status checks for known CLIs (default: true)',
          },
        },
        required: [],
      },
    };
  }

  async execute(input: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
    const rawNames = input.names;
    const names: string[] = Array.isArray(rawNames) && rawNames.every((n) => typeof n === 'string')
      ? rawNames as string[]
      : [...DEFAULT_CLIS];
    const checkAuth = input.check_auth !== false;

    log.info({ count: names.length, checkAuth }, 'Discovering CLIs');

    const results: CliResult[] = [];

    for (const name of names) {
      const path = Bun.which(name);
      if (!path) {
        results.push({ name, found: false });
        continue;
      }

      const result: CliResult = { name, found: true, path };

      // Version check
      const version = await runQuick(name, ['--version']);
      if (version) {
        // Take first line only — some tools emit multi-line version info
        result.version = version.split('\n')[0];
      }

      // Auth check
      if (checkAuth && AUTH_CHECK_COMMANDS[name]) {
        const [cmd, ...args] = AUTH_CHECK_COMMANDS[name];
        const authOutput = await runQuick(cmd, args);
        result.authenticated = authOutput !== null && authOutput.length > 0;
        if (authOutput) {
          // Keep auth info brief — first line, max 200 chars
          result.authInfo = truncate(authOutput.split('\n')[0], 200, '');
        }
      }

      results.push(result);
    }

    const found = results.filter((r) => r.found);
    const notFound = results.filter((r) => !r.found);

    const lines: string[] = [];

    if (found.length > 0) {
      lines.push('## Available CLIs\n');
      for (const r of found) {
        let line = `- **${r.name}** (${r.path})`;
        if (r.version) line += ` — ${r.version}`;
        if (r.authenticated === true) line += ` [authenticated${r.authInfo ? `: ${r.authInfo}` : ''}]`;
        else if (r.authenticated === false) line += ' [not authenticated]';
        lines.push(line);
      }
    }

    if (notFound.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(`## Not found: ${notFound.map((r) => r.name).join(', ')}`);
    }

    return {
      content: lines.join('\n'),
      isError: false,
    };
  }
}

export const cliDiscoverTool: Tool = new CliDiscoverTool();
