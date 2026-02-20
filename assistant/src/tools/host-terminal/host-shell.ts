import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { getConfig } from '../../config/loader.js';
import { getLogger } from '../../util/logger.js';
import { redactSecrets } from '../../security/secret-scanner.js';
import { formatShellOutput } from '../shared/shell-output.js';

const log = getLogger('host-shell-tool');

const SAFE_ENV_VARS = [
  'PATH',
  'HOME',
  'TERM',
  'LANG',
  'EDITOR',
  'SHELL',
  'USER',
  'TMPDIR',
  'LC_ALL',
  'LC_CTYPE',
  'XDG_RUNTIME_DIR',
  'DISPLAY',
  'COLORTERM',
  'TERM_PROGRAM',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GPG_TTY',
  'GNUPGHOME',
] as const;

function buildSanitizedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_VARS) {
    if (process.env[key] != null) {
      env[key] = process.env[key]!;
    }
  }
  // Ensure ~/.local/bin and ~/.bun/bin are in PATH so `vellum` and `bun` are
  // always reachable, even when the daemon is launched from a macOS app
  // bundle that inherits a minimal PATH.
  const home = homedir();
  const extraDirs = [`${home}/.local/bin`, `${home}/.bun/bin`];
  const currentPath = env.PATH ?? '';
  const missing = extraDirs.filter(d => !currentPath.split(':').includes(d));
  if (missing.length > 0) {
    env.PATH = [...missing, currentPath].filter(Boolean).join(':');
  }
  return env;
}

class HostShellTool implements Tool {
  name = 'host_bash';
  description = 'Execute a shell command on the host machine';
  category = 'host-terminal';
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
            description: 'The host shell command to execute',
          },
          reason: {
            type: 'string',
            description: 'Brief human-readable explanation of what this command does and why, shown to the user in the permission prompt (e.g. "to find available location services")',
          },
          working_dir: {
            type: 'string',
            description: 'Optional absolute host working directory (defaults to user home)',
          },
          timeout_seconds: {
            type: 'number',
            description: 'Optional timeout in seconds. Uses configured default and max limits.',
          },
        },
        required: ['command', 'reason'],
      },
    };
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const command = input.command as string;
    if (!command || typeof command !== 'string') {
      return { content: 'Error: command is required and must be a string', isError: true };
    }
    if (command.includes('\0')) {
      return { content: 'Error: command contains null bytes', isError: true };
    }

    const rawWorkingDir = input.working_dir;
    if (rawWorkingDir != null && typeof rawWorkingDir !== 'string') {
      return { content: 'Error: working_dir must be a string when provided', isError: true };
    }
    if (typeof rawWorkingDir === 'string' && rawWorkingDir.includes('\0')) {
      return { content: 'Error: working_dir contains null bytes', isError: true };
    }
    if (typeof rawWorkingDir === 'string' && !isAbsolute(rawWorkingDir)) {
      return { content: `Error: working_dir must be absolute for host command execution: ${rawWorkingDir}`, isError: true };
    }
    const workingDir = typeof rawWorkingDir === 'string' ? rawWorkingDir : homedir();

    const config = getConfig();
    const { shellDefaultTimeoutSec, shellMaxTimeoutSec } = config.timeouts;
    const requestedSec = typeof input.timeout_seconds === 'number' ? input.timeout_seconds : shellDefaultTimeoutSec;
    const timeoutSec = Math.max(1, Math.min(requestedSec, shellMaxTimeoutSec));
    const timeoutMs = timeoutSec * 1000;

    log.info({ command: redactSecrets(command), cwd: workingDir, timeoutSec, sessionId: context.sessionId }, 'Executing host shell command');

    return new Promise<ToolExecutionResult>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      const child = spawn('bash', ['-c', '--', command], {
        cwd: workingDir,
        env: buildSanitizedEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      // Cooperative cancellation via AbortSignal
      const onAbort = () => {
        child.kill('SIGKILL');
      };
      if (context.signal) {
        if (context.signal.aborted) {
          child.kill('SIGKILL');
        } else {
          context.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

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
        context.signal?.removeEventListener('abort', onAbort);

        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        const result = formatShellOutput(stdout, stderr, code, timedOut, timeoutSec);

        resolve({
          content: result.content,
          isError: result.isError,
          status: result.status,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        context.signal?.removeEventListener('abort', onAbort);
        let hint = '';
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          hint = !existsSync(workingDir)
            ? `. The working directory does not exist: ${workingDir}`
            : '. The command was not found — check that it is installed and in PATH.';
        }
        resolve({
          content: `Error spawning command: ${err.message}${hint}`,
          isError: true,
        });
      });
    });
  }
}

export const hostShellTool: Tool = new HostShellTool();
