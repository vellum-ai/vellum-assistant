import { getLogger } from '../util/logger.js';
import { getRootDir } from '../util/platform.js';
import { join } from 'node:path';

const log = getLogger('clawhub');

// Managed skills directory
function getManagedSkillsDir(): string {
  return join(getRootDir(), 'skills');
}

// Validate slug format (alphanumeric + hyphens only)
function validateSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) || /^[a-z0-9]$/.test(slug);
}

export interface ClawhubInstallResult {
  success: boolean;
  skillName?: string;
  version?: string;
  error?: string;
}

export interface ClawhubSearchResultItem {
  name: string;
  slug: string;
  description: string;
  author: string;
  stars: number;
  installs: number;
  version: string;
}

export interface ClawhubSearchResult {
  skills: ClawhubSearchResultItem[];
}

export interface ClawhubUpdateResult {
  success: boolean;
  updatedVersion?: string;
  error?: string;
}

export interface ClawhubUpdateCheckItem {
  name: string;
  installedVersion: string;
  latestVersion: string;
}

// Helper to run clawhub commands
async function runClawhub(args: string[], opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cwd = opts?.cwd ?? getManagedSkillsDir();
  const timeout = opts?.timeout ?? 60000;

  // Ensure managed skills dir exists
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cwd, { recursive: true });

  log.info({ args, cwd }, 'Running clawhub command');

  const proc = Bun.spawn(['npx', 'clawhub', ...args], {
    cwd,
    env: { ...process.env, CLAWHUB_DISABLE_TELEMETRY: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error(`clawhub command timed out after ${timeout}ms`));
    }, timeout);
  });

  const [stdout, stderr] = await Promise.race([
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]),
    timeoutPromise.then(() => ['', ''] as [string, string]),
  ]);

  const exitCode = await proc.exited;

  log.info({ exitCode, stdoutLen: stdout.length, stderrLen: stderr.length }, 'clawhub command completed');

  return { stdout, stderr, exitCode };
}

export async function clawhubInstall(slug: string, opts?: { version?: string }): Promise<ClawhubInstallResult> {
  if (!validateSlug(slug)) {
    return { success: false, error: `Invalid skill slug: ${slug}` };
  }

  const args = ['install', slug];
  if (opts?.version) args.push(`@${opts.version}`);
  args.push('--force'); // non-interactive

  try {
    const result = await runClawhub(args);
    if (result.exitCode !== 0) {
      const error = result.stderr.trim() || result.stdout.trim() || 'Unknown error';
      return { success: false, error };
    }
    return { success: true, skillName: slug };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export async function clawhubUpdate(name: string): Promise<ClawhubUpdateResult> {
  try {
    const result = await runClawhub(['update', name, '--force']);
    if (result.exitCode !== 0) {
      const error = result.stderr.trim() || result.stdout.trim() || 'Unknown error';
      return { success: false, error };
    }
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

export async function clawhubSearch(query: string): Promise<ClawhubSearchResult> {
  try {
    const result = await runClawhub(['search', query]);
    if (result.exitCode !== 0) {
      return { skills: [] };
    }
    // Try to parse JSON output; fall back to empty
    try {
      const parsed = JSON.parse(result.stdout);
      if (Array.isArray(parsed)) {
        return { skills: parsed };
      }
      if (parsed.skills && Array.isArray(parsed.skills)) {
        return parsed as ClawhubSearchResult;
      }
    } catch {
      // CLI may not output JSON -- parse text output
    }
    return { skills: [] };
  } catch (err) {
    log.warn({ err }, 'clawhub search failed');
    return { skills: [] };
  }
}

export async function clawhubCheckUpdates(): Promise<ClawhubUpdateCheckItem[]> {
  // This is a placeholder -- clawhub doesn't have a dedicated check-updates command
  // For now return empty; will be implemented when the CLI supports it
  return [];
}
