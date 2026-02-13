import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { homedir } from 'node:os';
import { getRootDir } from '../util/platform.js';
import { getLogger } from '../util/logger.js';
import { getHookSettings } from './config.js';
import type { DiscoveredHook, HookEventData } from './types.js';

const log = getLogger('hooks-runner');

function resolveBunPath(): string | null {
  const localBun = join(homedir(), '.bun', 'bin', 'bun');
  if (existsSync(localBun)) return localBun;
  // Fall back to PATH lookup — spawn will resolve it or fail with ENOENT
  return 'bun';
}

function getSpawnArgs(scriptPath: string): { command: string; args: string[] } | null {
  const ext = extname(scriptPath);
  if (ext === '.ts') {
    const bunPath = resolveBunPath();
    if (bunPath === null) return null;
    return { command: bunPath, args: ['run', scriptPath] };
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
    const spawnArgs = getSpawnArgs(hook.scriptPath);
    if (spawnArgs === null) {
      log.warn({ hook: hook.name }, 'Skipping .ts hook: bun runtime not found');
      resolve({ exitCode: null, stdout: '', stderr: 'bun runtime not found' });
      return;
    }
    const { command, args } = spawnArgs;
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
      child.kill('SIGTERM');
      // Give the process a short grace period to exit after SIGTERM, then SIGKILL
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 2000);
      child.once('close', () => {
        clearTimeout(killTimer);
        if (settled) return;
        settled = true;
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
