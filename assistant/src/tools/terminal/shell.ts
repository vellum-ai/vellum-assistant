import { spawn } from 'node:child_process';
import { RiskLevel } from '../../permissions/types.js';
import type { Tool, ToolContext, ToolExecutionResult } from '../types.js';
import type { ToolDefinition } from '../../providers/types.js';
import { registerTool } from '../registry.js';
import { getConfig } from '../../config/loader.js';
import { getLogger } from '../../util/logger.js';

const log = getLogger('shell-tool');

const MAX_OUTPUT_LENGTH = 50_000;

class ShellTool implements Tool {
  name = 'shell';
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

    const config = getConfig();
    const { shellDefaultTimeoutSec, shellMaxTimeoutSec } = config.timeouts;
    const requestedSec = typeof input.timeout_seconds === 'number' ? input.timeout_seconds : shellDefaultTimeoutSec;
    const timeoutSec = Math.max(1, Math.min(requestedSec, shellMaxTimeoutSec));
    const timeoutMs = timeoutSec * 1000;

    log.info({ command, cwd: context.workingDir, timeoutSec }, 'Executing shell command');

    return new Promise<ToolExecutionResult>((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // The '--' separator prevents bash from interpreting the command
      // string as additional flags if it starts with '-'.
      const child = spawn('bash', ['-c', '--', command], {
        cwd: context.workingDir,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        context.onOutput?.(chunk);
      });

      child.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        context.onOutput?.(chunk);
      });

      child.on('close', (code) => {
        clearTimeout(timer);

        let output = stdout;
        if (stderr) {
          output += (output ? '\n' : '') + stderr;
        }

        if (timedOut) {
          output += `\n[Command timed out after ${timeoutSec}s]`;
        }

        // Truncate if too long
        if (output.length > MAX_OUTPUT_LENGTH) {
          output = output.slice(0, MAX_OUTPUT_LENGTH) + '\n[Output truncated at 50K characters]';
        }

        if (!output.trim()) {
          output = code === 0 ? '[Command completed with no output]' : `[Command exited with code ${code}]`;
        }

        resolve({
          content: output,
          isError: code !== 0 || timedOut,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          content: `Error spawning command: ${err.message}`,
          isError: true,
        });
      });
    });
  }
}

registerTool(new ShellTool());
