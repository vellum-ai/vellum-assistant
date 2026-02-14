import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { getConfig } from '../../config/loader.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('host-shell-tool');

const MAX_OUTPUT_LENGTH = 50_000;

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
          working_dir: {
            type: 'string',
            description: 'Optional absolute host working directory (defaults to user home)',
          },
          timeout_seconds: {
            type: 'number',
            description: 'Optional timeout in seconds. Uses configured default and max limits.',
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
    if (command.includes('\0')) {
      return { content: 'Error: command contains null bytes', isError: true };
    }

    const rawWorkingDir = input.working_dir;
    if (rawWorkingDir != null && typeof rawWorkingDir !== 'string') {
      return { content: 'Error: working_dir must be a string when provided', isError: true };
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

    log.info({ command, cwd: workingDir, timeoutSec, sessionId: context.sessionId }, 'Executing host shell command');

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

        let output = stdout;
        if (stderr) {
          output += (output ? '\n' : '') + stderr;
        }

        const statusParts: string[] = [];

        if (timedOut) {
          const msg = `<command_timeout seconds="${timeoutSec}" />`;
          output += `\n${msg}`;
          statusParts.push(msg);
        }

        if (output.length > MAX_OUTPUT_LENGTH) {
          const msg = '<output_truncated limit="50K" />';
          output = output.slice(0, MAX_OUTPUT_LENGTH) + `\n${msg}`;
          statusParts.push(msg);
        }

        if (!output.trim()) {
          output = code === 0 ? '<command_completed />' : `<command_exit code="${code}" />`;
        } else if (code !== 0 && !timedOut) {
          statusParts.push(`<command_exit code="${code}" />`);
        }

        resolve({
          content: output,
          isError: code !== 0 || timedOut,
          status: statusParts.length > 0 ? statusParts.join('\n') : undefined,
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
  }
}

export const hostShellTool: Tool = new HostShellTool();
