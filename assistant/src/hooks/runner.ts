import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { getRootDir } from '../util/platform.js';
import { getHookSettings } from './config.js';
import type { DiscoveredHook, HookEventData } from './types.js';

/**
 * Resolve a usable bun runtime path. When the daemon runs under plain bun
 * (dev mode), `process.execPath` is the bun CLI and works directly.  When the
 * daemon is a `bun build --compile` binary, `process.execPath` points to the
 * compiled binary itself -- spawning it with `['run', script]` would re-launch
 * the daemon.  In that case we locate bun via PATH or at `~/.bun/bin/bun`.
 */
function resolveBunPath(): string {
  const execBasename = basename(process.execPath);
  if (execBasename === 'bun' || execBasename === 'bun.exe') {
    return process.execPath;
  }

  // Compiled-binary mode -- find a standalone bun runtime.
  const found = Bun.which('bun');
  if (found) return found;

  const fallback = join(homedir(), '.bun', 'bin', 'bun');
  if (existsSync(fallback)) return fallback;

  // Last resort: hope process.execPath can handle it (shouldn't get here).
  return process.execPath;
}

function getSpawnArgs(scriptPath: string): { command: string; args: string[] } {
  const ext = extname(scriptPath);
  if (ext === '.ts') {
    return { command: resolveBunPath(), args: ['run', scriptPath] };
  }
  return { command: scriptPath, args: [] };
}

export interface HookRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export async function runHookScript(
  hook: DiscoveredHook,
  eventData: HookEventData,
  options?: { timeoutMs?: number },
): Promise<HookRunResult> {
  const timeoutMs = options?.timeoutMs ?? 5000;

  return new Promise<HookRunResult>((resolve) => {
    const { command, args } = getSpawnArgs(hook.scriptPath);
    const child = spawn(command, args, {
      cwd: hook.dir,
      env: {
        ...process.env,
        VELLUM_HOOK_EVENT: eventData.event,
        VELLUM_HOOK_NAME: hook.name,
        VELLUM_ROOT_DIR: getRootDir(),
        VELLUM_HOOK_SETTINGS: JSON.stringify(getHookSettings(hook.name, hook.manifest)),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      // Give the process a short grace period to exit after SIGTERM, then SIGKILL
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 2000);
      child.once('close', () => {
        clearTimeout(killTimer);
        resolve({ exitCode: null, stdout, stderr: stderr + '\nHook timed out' });
      });
    }, timeoutMs);

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + '\n' + err.message });
    });

    // Suppress unhandled EPIPE errors if the child exits before we finish writing
    child.stdin.on('error', () => {});
    // Write event data to stdin and close
    child.stdin.write(JSON.stringify(eventData));
    child.stdin.end();
  });
}
