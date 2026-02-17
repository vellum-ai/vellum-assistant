import * as net from 'node:net';
import { execFile } from 'node:child_process';
import type { DoctorBashRequest } from '../ipc-contract.js';
import { log, type HandlerContext } from './shared.js';

const TIMEOUT_MS = 15_000;

interface AllowedCommand {
  binary: string;
  args?: readonly string[];
  description: string;
}

const ALLOWED_COMMANDS: readonly AllowedCommand[] = [
  { binary: 'bun', args: ['--version'], description: 'Check Bun version' },
  { binary: 'docker', args: ['--version'], description: 'Check Docker CLI version' },
  { binary: 'docker', args: ['info'], description: 'Check Docker daemon status' },
  { binary: 'git', args: ['--version'], description: 'Check Git version' },
  { binary: 'node', args: ['--version'], description: 'Check Node.js version' },
  { binary: 'npm', args: ['--version'], description: 'Check npm version' },
  { binary: 'python3', args: ['--version'], description: 'Check Python version' },
  { binary: 'sw_vers', description: 'Show macOS version' },
  { binary: 'uname', args: ['-a'], description: 'Show system info' },
  { binary: 'which', args: ['bun'], description: 'Locate bun binary' },
  { binary: 'which', args: ['docker'], description: 'Locate docker binary' },
  { binary: 'which', args: ['git'], description: 'Locate git binary' },
  { binary: 'which', args: ['node'], description: 'Locate node binary' },
  { binary: 'df', args: ['-h', '/'], description: 'Check disk space' },
  { binary: 'uptime', description: 'Show system uptime' },
  { binary: 'whoami', description: 'Show current user' },
  { binary: 'hostname', description: 'Show hostname' },
  { binary: 'printenv', args: ['SHELL'], description: 'Show default shell' },
  { binary: 'printenv', args: ['PATH'], description: 'Show PATH' },
  { binary: 'sysctl', args: ['-n', 'hw.memsize'], description: 'Show total memory (macOS)' },
  { binary: 'sysctl', args: ['-n', 'hw.ncpu'], description: 'Show CPU count (macOS)' },
];

function matchesAllowedCommand(command: string): AllowedCommand | undefined {
  const parts = command.trim().split(/\s+/);
  const binary = parts[0];
  const args = parts.slice(1);

  return ALLOWED_COMMANDS.find((allowed) => {
    if (allowed.binary !== binary) {
      return false;
    }
    const allowedArgs = allowed.args ?? [];
    if (allowedArgs.length !== args.length) {
      return false;
    }
    return allowedArgs.every((a, i) => a === args[i]);
  });
}

export function getAvailableDoctorCommands(): Array<{ command: string; description: string }> {
  return ALLOWED_COMMANDS.map((c) => ({
    command: c.args ? `${c.binary} ${c.args.join(' ')}` : c.binary,
    description: c.description,
  }));
}

export async function handleDoctorBash(
  msg: DoctorBashRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const { command } = msg;

  if (!command || typeof command !== 'string') {
    ctx.send(socket, {
      type: 'doctor_bash_response',
      command: command ?? '',
      success: false,
      error: 'command is required and must be a string',
    });
    return;
  }

  const matched = matchesAllowedCommand(command);
  if (!matched) {
    const available = getAvailableDoctorCommands();
    ctx.send(socket, {
      type: 'doctor_bash_response',
      command,
      success: false,
      error: `Command not in allowlist. Use "doctor_bash_list" to see available commands.`,
      availableCommands: available,
    });
    return;
  }

  const args = matched.args ? [...matched.args] : [];

  log.info({ command, binary: matched.binary, args }, 'Executing doctor bash command');

  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(matched.binary, args, { timeout: TIMEOUT_MS, encoding: 'utf-8' }, (err, stdout, stderr) => {
        if (err) {
          const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
          reject(new Error(combined || err.message));
          return;
        }
        resolve([stdout, stderr].filter(Boolean).join('\n').trim());
      });
    });

    ctx.send(socket, {
      type: 'doctor_bash_response',
      command,
      success: true,
      output,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.warn({ command, err: errorMessage }, 'Doctor bash command failed');
    ctx.send(socket, {
      type: 'doctor_bash_response',
      command,
      success: false,
      error: errorMessage,
    });
  }
}

export function handleDoctorBashList(
  _msg: { type: 'doctor_bash_list' },
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  ctx.send(socket, {
    type: 'doctor_bash_list_response',
    commands: getAvailableDoctorCommands(),
  });
}
