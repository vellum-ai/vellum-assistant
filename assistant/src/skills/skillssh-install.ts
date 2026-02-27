import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getLogger } from '../util/logger.js';
import { getWorkspaceSkillsDir } from '../util/platform.js';
import { validateSlug, verifyAndRecordSkillHash } from './clawhub.js';
import { upsertSkillsIndexEntry } from './managed-store.js';
import type { SecurityDecision } from './security-decision.js';
import type { SkillsShSearchWithAuditItem } from './skillssh.js';

const log = getLogger('skillssh-install');

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface SkillsShInstallOptions {
  /** The skill candidate from search-with-audit results */
  candidate: SkillsShSearchWithAuditItem;
  /** The security decision for this skill */
  securityDecision: SecurityDecision;
  /** Whether the user has explicitly overridden security restrictions */
  userOverride?: boolean;
}

export interface SkillsShInstallResult {
  success: boolean;
  skillId: string;
  /** Source-namespaced ID used for the install directory (e.g. "org--repo--my-skill") */
  namespacedId: string;
  /** The managed skill directory path */
  installedPath?: string;
  /** Error message if install failed */
  error?: string;
  /** Whether installation was allowed by policy or via user override */
  installedVia: 'policy' | 'override';
  /** Provenance metadata stored with the skill */
  provenance?: SkillsShProvenance;
}

export interface SkillsShProvenance {
  provider: 'skills.sh';
  source: string;
  skillId: string;
  sourceUrl: string;
  auditSnapshot: {
    overallRisk: string;
    dimensions: Array<{
      provider: string;
      risk: string;
      analyzedAt: string;
    }>;
    capturedAt: string;
  };
}

// ─── Path helpers ────────────────────────────────────────────────────────────────

function getManagedSkillsDir(): string {
  return getWorkspaceSkillsDir();
}

// `npx skills add` creates a `skills/` subdir inside its cwd,
// so we use the parent of the managed skills dir as the project root.
function getSkillsShProjectRoot(): string {
  return dirname(getWorkspaceSkillsDir());
}

/**
 * Derive a source-namespaced directory name from source and skillId.
 * Replaces slashes with double-hyphens so the result is a flat, safe directory name.
 * Example: source="org/repo", skillId="my-skill" -> "org--repo--my-skill"
 */
export function namespacedSkillDir(source: string, skillId: string): string {
  const sanitized = source.replace(/\//g, '--');
  return `${sanitized}--${skillId}`;
}

// ─── Subprocess runner ───────────────────────────────────────────────────────────

async function runSkillsAdd(
  source: string,
  skillId: string,
  opts?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const cwd = getSkillsShProjectRoot();
  const timeout = opts?.timeout ?? 60000;

  mkdirSync(cwd, { recursive: true });

  const skillRef = `${source}/${skillId}`;
  log.info({ skillRef, cwd }, 'Running npx skills add');

  const proc = Bun.spawn(['npx', 'skills', 'add', skillRef], {
    cwd,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<[string, string]>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`skills add command timed out after ${timeout}ms`));
    }, timeout);
  });

  const [stdout, stderr] = await Promise.race([
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]),
    timeoutPromise,
  ]).finally(() => clearTimeout(timer!));

  // Suppress unhandled rejection from the losing timeout promise
  timeoutPromise.catch(() => {});

  const exitCode = await proc.exited;

  log.info(
    { exitCode, stdoutLen: stdout.length, stderrLen: stderr.length },
    'skills add command completed',
  );

  return { stdout, stderr, exitCode };
}

// ─── Provenance builder ──────────────────────────────────────────────────────────

function buildProvenance(candidate: SkillsShSearchWithAuditItem): SkillsShProvenance {
  const dimensions: SkillsShProvenance['auditSnapshot']['dimensions'] = [];

  for (const provider of ['ath', 'socket', 'snyk'] as const) {
    const dim = candidate.audit[provider];
    if (dim) {
      dimensions.push({
        provider,
        risk: dim.risk,
        analyzedAt: dim.analyzedAt,
      });
    }
  }

  return {
    provider: 'skills.sh',
    source: candidate.source,
    skillId: candidate.skillId,
    sourceUrl: `https://skills.sh/skills/${candidate.source}/${candidate.skillId}`,
    auditSnapshot: {
      overallRisk: candidate.overallRisk,
      dimensions,
      capturedAt: new Date().toISOString(),
    },
  };
}

// ─── Install function ────────────────────────────────────────────────────────────

export async function skillsshInstall(
  options: SkillsShInstallOptions,
): Promise<SkillsShInstallResult> {
  const { candidate, securityDecision, userOverride } = options;
  const { skillId, source } = candidate;

  const nsId = namespacedSkillDir(source, skillId);

  // Reject invalid skill IDs and source identifiers before computing install
  // paths -- prevents empty strings, path traversal segments, or other malformed
  // identifiers from targeting unexpected directories.
  if (!validateSlug(skillId)) {
    return {
      success: false,
      skillId,
      namespacedId: nsId,
      installedVia: 'policy',
      error: `Invalid skill ID: ${skillId}`,
    };
  }
  if (!source || source.includes('..') || /[\\]/.test(source)) {
    return {
      success: false,
      skillId,
      namespacedId: nsId,
      installedVia: 'policy',
      error: `Invalid source: ${source}`,
    };
  }

  // Gate: block do_not_recommend installs unless the user explicitly overrides
  if (securityDecision.recommendation === 'do_not_recommend' && !userOverride) {
    return {
      success: false,
      skillId,
      namespacedId: nsId,
      installedVia: 'policy',
      error:
        `Installation blocked: security assessment is "${securityDecision.recommendation}" ` +
        `(${securityDecision.overallRisk} risk). ${securityDecision.rationale}`,
    };
  }

  const installedVia: 'policy' | 'override' =
    securityDecision.recommendation === 'do_not_recommend' ? 'override' : 'policy';

  try {
    const result = await runSkillsAdd(source, skillId);

    if (result.exitCode !== 0) {
      const error = result.stderr.trim() || result.stdout.trim() || 'Unknown error';
      return { success: false, skillId, namespacedId: nsId, installedVia, error };
    }

    // `npx skills add` installs into skills/<skillId>/SKILL.md relative to the
    // project root. We then relocate it to a source-namespaced directory to
    // prevent ID collisions between different repos publishing the same skillId.
    const rawInstalledDir = join(getManagedSkillsDir(), skillId);
    const namespacedDir = join(getManagedSkillsDir(), nsId);
    const rawSkillFile = join(rawInstalledDir, 'SKILL.md');

    if (!existsSync(rawSkillFile)) {
      return {
        success: false,
        skillId,
        namespacedId: nsId,
        installedVia,
        error: `Installation completed but SKILL.md not found at expected path: ${rawSkillFile}`,
      };
    }

    // Relocate to namespaced directory when the raw and namespaced paths differ
    if (rawInstalledDir !== namespacedDir) {
      mkdirSync(dirname(namespacedDir), { recursive: true });
      renameSync(rawInstalledDir, namespacedDir);
    }

    const installedDir = namespacedDir;

    // Write provenance metadata before computing the integrity hash so the
    // hash is stable on re-install. collectFileContents already excludes
    // .provenance.json, but writing it first avoids any ordering ambiguity.
    const provenance = buildProvenance(candidate);
    const provenancePath = join(installedDir, '.provenance.json');
    writeFileSync(provenancePath, JSON.stringify(provenance, null, 2) + '\n', 'utf-8');

    // Record content integrity hash (trust-on-first-use)
    verifyAndRecordSkillHash(nsId);

    // Add to SKILLS.md index so the skill is discoverable
    try {
      upsertSkillsIndexEntry(nsId);
    } catch (err) {
      log.warn({ err, nsId }, 'Failed to update SKILLS.md index after install');
    }

    log.info(
      { skillId, namespacedId: nsId, source, installedVia, installedDir },
      'skills.sh skill installed successfully',
    );

    return {
      success: true,
      skillId,
      namespacedId: nsId,
      installedPath: installedDir,
      installedVia,
      provenance,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, skillId, namespacedId: nsId, installedVia, error: message };
  }
}
