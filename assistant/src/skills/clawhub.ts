import { getLogger } from '../util/logger.js';
import { getRootDir } from '../util/platform.js';
import { join } from 'node:path';

const log = getLogger('clawhub');

// Managed skills directory
function getManagedSkillsDir(): string {
  return join(getRootDir(), 'skills');
}

// Validate slug format (alphanumeric, hyphens, dots, underscores; optional namespace with single slash)
function validateSlug(slug: string): boolean {
  return /^[a-zA-Z0-9]([a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)?)?$/.test(slug);
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
  createdAt: number;
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

  const installSlug = opts?.version ? `${slug}@${opts.version}` : slug;
  const args = ['install', installSlug, '--force']; // non-interactive

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
  // Empty query: use explore (browse trending) instead of search
  if (!query.trim()) {
    return clawhubExplore();
  }

  try {
    const result = await runClawhub(['search', query, '--limit', '25']);
    if (result.exitCode !== 0) {
      return { skills: [] };
    }
    // Try JSON first
    try {
      const parsed = JSON.parse(result.stdout);
      if (Array.isArray(parsed)) {
        return { skills: parsed };
      }
      if (parsed.skills && Array.isArray(parsed.skills)) {
        return parsed as ClawhubSearchResult;
      }
    } catch {
      // CLI outputs text: "slug vVersion  DisplayName  (score)"
    }

    // Parse text output lines: "slug vVersion  Display Name  (score)"
    const skills: ClawhubSearchResultItem[] = [];
    for (const line of result.stdout.split('\n')) {
      const match = line.match(/^(\S+)\s+v(\S+)\s+(.+?)\s+\([\d.]+\)\s*$/);
      if (match) {
        skills.push({
          slug: match[1],
          version: match[2],
          name: match[3].trim(),
          description: '',
          author: '',
          stars: 0,
          installs: 0,
          createdAt: 0,
        });
      }
    }
    return { skills };
  } catch (err) {
    log.warn({ err }, 'clawhub search failed');
    return { skills: [] };
  }
}

export async function clawhubExplore(opts?: { limit?: number; sort?: string }): Promise<ClawhubSearchResult> {
  const limit = String(opts?.limit ?? 25);
  const sort = opts?.sort ?? 'installsAllTime';

  try {
    const result = await runClawhub(['explore', '--json', '--limit', limit, '--sort', sort]);
    if (result.exitCode !== 0) {
      return { skills: [] };
    }
    try {
      const parsed = JSON.parse(result.stdout);
      const items = parsed.items ?? parsed;
      if (!Array.isArray(items)) return { skills: [] };

      // Normalize explore response to ClawhubSearchResultItem shape
      const skills: ClawhubSearchResultItem[] = items.map((item: Record<string, unknown>) => ({
        name: (item.displayName as string) ?? (item.slug as string) ?? '',
        slug: (item.slug as string) ?? '',
        description: (item.summary as string) ?? '',
        author: (item.author as string) ?? '',
        stars: (item.stats as Record<string, number>)?.stars ?? 0,
        installs: (item.stats as Record<string, number>)?.installsAllTime ?? 0,
        version: (item.tags as Record<string, string>)?.latest ?? '',
        createdAt: (item.createdAt as number) ?? 0,
      }));
      return { skills };
    } catch {
      // parse failure
    }
    return { skills: [] };
  } catch (err) {
    log.warn({ err }, 'clawhub explore failed');
    return { skills: [] };
  }
}

export async function clawhubCheckUpdates(): Promise<ClawhubUpdateCheckItem[]> {
  // This is a placeholder -- clawhub doesn't have a dedicated check-updates command
  // For now return empty; will be implemented when the CLI supports it
  return [];
}
