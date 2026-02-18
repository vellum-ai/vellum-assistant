import { spawn } from 'node:child_process';
import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { getConfig } from '../../config/loader.js';
import { getLogger } from '../../util/logger.js';
import { redactSecrets } from '../../security/secret-scanner.js';
import { wrapCommand } from './sandbox.js';
import { formatShellOutput } from '../shared/shell-output.js';
import { buildSanitizedEnv } from './safe-env.js';
import {
  getOrStartSession,
  getSessionEnv,
} from '../network/script-proxy/index.js';
import { getDataDir } from '../../util/platform.js';

const log = getLogger('shell-tool');

class ShellTool implements Tool {
  name = 'bash';
  description = 'Execute a shell command on the local machine';
  category = 'terminal';
  defaultRiskLevel = RiskLevel.Medium;

  getDefinition(): ToolDefinition {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute',
          },
          timeout_seconds: {
            type: 'number',
            description: 'Optional timeout in seconds. Defaults to the configured default (120s). Cannot exceed the configured maximum.',
          },
          network_mode: {
            type: 'string',
            enum: ['off', 'proxied'],
            description: 'Network access mode for the command. "off" (default) blocks network access; "proxied" routes traffic through the credential proxy.',
          },
          credential_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of credential IDs to inject via the proxy when network_mode is "proxied".',
          },
        },
        required: ['command'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const command = input.command as string;
    if (!command || typeof command !== 'string') {
      return { content: 'Error: command is required and must be a string', isError: true };
    }

    // Reject commands containing null bytes — they cause truncation at the
    // OS level while the parser sees the full string, enabling bypass.
    if (command.includes('\0')) {
      return { content: 'Error: command contains null bytes', isError: true };
    }

    const networkMode: 'off' | 'proxied' =
      input.network_mode === 'proxied' ? 'proxied' : 'off';

    const credentialIds: string[] = [];
    if (Array.isArray(input.credential_ids)) {
      for (const id of input.credential_ids) {
        if (typeof id === 'string' && id.length > 0) {
          credentialIds.push(id);
        }
      }
    }

    const config = getConfig();
    const { shellDefaultTimeoutSec, shellMaxTimeoutSec } = config.timeouts;
    const requestedSec = typeof input.timeout_seconds === 'number' ? input.timeout_seconds : shellDefaultTimeoutSec;
    const timeoutSec = Math.max(1, Math.min(requestedSec, shellMaxTimeoutSec));
    const timeoutMs = timeoutSec * 1000;

    log.info({ command: redactSecrets(command), cwd: context.workingDir, timeoutSec, networkMode, credentialIds }, 'Executing shell command');

    // Resolve sandbox config early — needed both for proxy env and command wrapping.
    const sandboxConfig = context.sandboxOverride != null
      ? { ...config.sandbox, enabled: context.sandboxOverride }
      : config.sandbox;
    const isDockerSandbox = sandboxConfig.enabled && sandboxConfig.backend === 'docker';

    // Acquire proxy session if proxied mode is requested.
    // `getOrStartSession` serializes per-conversation so concurrent proxied
    // commands share a single session instead of each creating one.
    // Sessions are NOT stopped here — the session manager's idle timer handles
    // cleanup after all commands finish (see resetIdleTimer / stopAllSessions).
    let proxyEnv: import('../network/script-proxy/types.js').ProxyEnvVars | null = null;

    if (networkMode === 'proxied') {
      try {
        const { session } = await getOrStartSession(
          context.conversationId,
          credentialIds,
          undefined,
          getDataDir(),
          context.proxyApprovalCallback,
        );
        proxyEnv = getSessionEnv(session.id, { dockerMode: isDockerSandbox });
      } catch (err) {
        log.error({ err }, 'Failed to start proxy session');
        return {
          content: `Error: failed to start proxy session — ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    }

    const env = buildSanitizedEnv();
    if (proxyEnv) {
      Object.assign(env, proxyEnv);
    }

    const result = await new Promise<ToolExecutionResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      const wrapped = wrapCommand(command, context.workingDir, sandboxConfig, { networkMode });
      const child = spawn(wrapped.command, wrapped.args, {
        cwd: context.workingDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (data: Buffer) => {
        stdoutChunks.push(data);
        context.onOutput?.(data.toString());
      });

      child.stderr.on('data', (data: Buffer) => {
        stderrChunks.push(data);
        context.onOutput?.(data.toString());
      });

      child.on('close', (code) => {
        clearTimeout(timer);

        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        const fmtResult = formatShellOutput(stdout, stderr, code, timedOut, timeoutSec);

        resolve({
          content: fmtResult.content,
          isError: fmtResult.isError,
          status: fmtResult.status,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          content: `Error spawning command: ${err.message}${(err as NodeJS.ErrnoException).code === 'ENOENT' ? '. The command was not found — check that it is installed and in PATH.' : ''}`,
          isError: true,
        });
      });
    });

    return result;
  }
}

export const shellTool: Tool = new ShellTool();
registerTool(shellTool);
