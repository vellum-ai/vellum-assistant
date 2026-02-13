import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { getRootDir } from '../util/platform.js';
import { getHookSettings } from './config.js';
import type { DiscoveredHook, HookEventData } from './types.js';

function getSpawnArgs(scriptPath: string): { command: string; args: string[] } {
  const ext = extname(scriptPath);
  if (ext === '.ts') {
    // process.execPath is the bun runtime (or compiled bun binary) that
    // started the daemon, so .ts hooks work without a separate bun install.
    return { command: process.execPath, args: ['run', scriptPath] };
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
      });
      resolve({ exitCode: null, stdout, stderr: stderr + '\nHook timed out' });
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
