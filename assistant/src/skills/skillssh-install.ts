import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getLogger } from '../util/logger.js';
import { getWorkspaceSkillsDir } from '../util/platform.js';
import { verifyAndRecordSkillHash } from './clawhub.js';
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

  // Gate: block do_not_recommend installs unless the user explicitly overrides
  if (securityDecision.recommendation === 'do_not_recommend' && !userOverride) {
    return {
      success: false,
      skillId,
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
      return { success: false, skillId, installedVia, error };
    }

    // `npx skills add` installs into skills/<skillId>/SKILL.md relative to the project root.
    // The project root is the parent of the managed skills dir, so the installed
    // path lands inside the managed skills dir.
    const installedDir = join(getManagedSkillsDir(), skillId);
    const skillFile = join(installedDir, 'SKILL.md');

    if (!existsSync(skillFile)) {
      return {
        success: false,
        skillId,
        installedVia,
        error: `Installation completed but SKILL.md not found at expected path: ${skillFile}`,
      };
    }

    // Record content integrity hash (trust-on-first-use)
    verifyAndRecordSkillHash(skillId);

    // Store provenance metadata alongside the skill
    const provenance = buildProvenance(candidate);
    const provenancePath = join(installedDir, '.provenance.json');
    writeFileSync(provenancePath, JSON.stringify(provenance, null, 2) + '\n', 'utf-8');

    log.info(
      { skillId, source, installedVia, installedDir },
      'skills.sh skill installed successfully',
    );

    return {
      success: true,
      skillId,
      installedPath: installedDir,
      installedVia,
      provenance,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, skillId, installedVia, error: message };
  }
}
