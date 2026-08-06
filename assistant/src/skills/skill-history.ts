// ---------------------------------------------------------------------------
// Skill revision history, read from the workspace git repository.
// ---------------------------------------------------------------------------
//
// The workspace is a git repo with an auto-committing heartbeat, and `skills/`
// is tracked, so every managed-skill write already has its prior content
// retained. This module reads that history rather than storing a second copy:
// `createManagedSkill` writes through an atomic rename and keeps no version of
// its own, but the commit underneath it does.
//
// A revision here is ONE UPDATE TO THE WHOLE SKILL, not a per-file log. A
// single commit is diffed against the skill's directory, so `SKILL.md`,
// `scripts/`, and `references/` changes made together appear as one entry with
// one combined diff, which is what "what changed the last time this skill was
// updated" means. The commit itself usually touches many unrelated files (the
// heartbeat batches by count and age), so the pathspec is what makes the diff
// legible.
//
// Two properties of that history shape the output, and both are load-bearing:
//
//   - `install-meta.json` is EXCLUDED. It carries a `lastUsedAt` stamp
//     refreshed every time a skill is loaded, so roughly half of a skill's
//     commits touch nothing else. Including it would report a skill as
//     "updated" on days nobody edited it, which is worse than showing no
//     history at all. Revisions left empty by the exclusion are dropped.
//   - History is BOUNDED. The workspace periodically squashes
//     ("Compacted workspace history"), so the oldest revision available is not
//     necessarily the skill's creation. Callers should present the list as
//     "recent changes", never as a complete record.
//
// Commit subjects are deliberately not surfaced: they read
// `auto-commit: heartbeat safety net (164 files, changes older than 900s)`,
// which describes the batch rather than the skill and would actively mislead.
//
// Every git call goes through `runReadOnlyGitWithoutInit`, NOT
// `runReadOnlyGit`. The latter awaits `ensureInitialized()`, which creates the
// repository, writes `.gitignore` and the hooks directory, makes an initial
// commit, and schedules a history compaction when the workspace is not yet a
// repo. This module is reached from an HTTP GET, which `src/runtime/AGENTS.md`
// requires to be side-effect-free, so observing history must never be the
// thing that brings a repository into existence.

import { getLogger } from "../util/logger.js";
import { getWorkspaceDir } from "../util/platform.js";
import { getWorkspaceGitService } from "../workspace/git-service.js";
import { validateManagedSkillId } from "./managed-store.js";

const log = getLogger("skill-history");

/** How many revisions to return when the caller does not specify. */
export const DEFAULT_SKILL_HISTORY_LIMIT = 20;

/** Hard ceiling, so one request cannot walk an entire repository. */
export const MAX_SKILL_HISTORY_LIMIT = 100;

/** One update to a skill: a commit, diffed to that skill's directory. */
export interface SkillRevision {
  /** Abbreviated commit hash. Opaque to callers; useful for support. */
  id: string;
  /** ISO-8601 commit timestamp. */
  changedAt: string;
  /** Paths changed inside the skill, relative to the skill directory. */
  files: string[];
  /** Unified diff of this commit, restricted to the skill's directory. */
  diff: string;
}

export interface SkillHistory {
  skillId: string;
  revisions: SkillRevision[];
  /**
   * Whether history may be incomplete because the workspace squashed older
   * commits. When true the oldest revision listed is a floor, not the
   * skill's creation.
   */
  truncatedByCompaction: boolean;
}

/**
 * Field separator for the `git log` format: an ASCII unit separator, written
 * as an escape so the source stays copy-paste safe. It cannot occur in a
 * commit hash or an ISO timestamp.
 */
const FIELD = "\u001f";

/**
 * Diff options that must accompany EVERY git read here.
 *
 * `git show` and `git diff` honour repository-controlled helpers by default:
 * a `.gitattributes` entry can select a diff driver, and a `diff.<driver>.
 * textconv` or `diff.<driver>.command` setting names a program git then
 * EXECUTES while rendering the patch. Workspace files and git metadata are
 * writable by model and tool paths, so without these flags merely viewing a
 * skill's history would run whatever the workspace asked for, inside the
 * daemon, on behalf of any caller holding `settings.read` (ATL-1238).
 *
 * Applied through `readGit` rather than at each call site, so a future reader
 * cannot add a git invocation that quietly omits them.
 */
const DIFF_HARDENING = ["--no-textconv", "--no-ext-diff"];

/**
 * Run one hardened, non-initializing git read. The subcommand is passed
 * separately because the hardening flags have to follow it.
 */
async function readGit(
  git: ReturnType<typeof getWorkspaceGitService>,
  subcommand: "log" | "show",
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return git.runReadOnlyGitWithoutInit([
    subcommand,
    ...DIFF_HARDENING,
    ...args,
  ]);
}

/**
 * Read a skill's recent revisions from workspace git.
 *
 * Returns an empty history rather than throwing when git is unavailable, the
 * workspace is not a repository, or the skill has no tracked changes: history
 * is a read-only enrichment and must never be the reason a caller fails.
 * An invalid skill id DOES throw, because it means the caller passed
 * unvalidated input into a pathspec.
 */
export async function getSkillHistory(
  skillId: string,
  options: { limit?: number } = {},
): Promise<SkillHistory> {
  const invalid = validateManagedSkillId(skillId);
  if (invalid) {
    throw new Error(`Invalid skill id: ${invalid}`);
  }
  const limit = Math.min(
    Math.max(1, options.limit ?? DEFAULT_SKILL_HISTORY_LIMIT),
    MAX_SKILL_HISTORY_LIMIT,
  );

  const empty: SkillHistory = {
    skillId,
    revisions: [],
    truncatedByCompaction: false,
  };

  let git: ReturnType<typeof getWorkspaceGitService>;
  try {
    git = getWorkspaceGitService(getWorkspaceDir());
  } catch (err) {
    log.warn({ err, skillId }, "workspace git unavailable; no skill history");
    return empty;
  }

  const skillPath = `skills/${skillId}/`;
  // Exclude the usage stamp so a skill that was merely LOADED does not read as
  // edited. `:(exclude)` is git pathspec magic, applied to both the log and
  // the per-commit diff so the two can never disagree about what counts.
  const pathspec = [skillPath, `:(exclude)${skillPath}install-meta.json`];

  let shas: Array<{ sha: string; changedAt: string }>;
  try {
    const { stdout } = await readGit(git, "log", [
      // Committer date, not author date. `git log` orders by commit date, so
      // reporting the author date could label the list newest-first while its
      // displayed dates disagree with that order.
      `--format=%h${FIELD}%cI`,
      // Ask for more than `limit`: commits whose only in-skill change is
      // excluded by the pathspec still appear here, so the list is filtered
      // down afterwards and would otherwise come up short.
      `--max-count=${limit * 4}`,
      "--",
      ...pathspec,
    ]);
    shas = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha, changedAt] = line.split(FIELD);
        return { sha: sha ?? "", changedAt: changedAt ?? "" };
      })
      .filter((entry) => entry.sha.length > 0);
  } catch (err) {
    log.warn({ err, skillId }, "git log failed; no skill history");
    return empty;
  }

  const revisions: SkillRevision[] = [];
  for (const { sha, changedAt } of shas) {
    if (revisions.length >= limit) {
      break;
    }
    let diff: string;
    let files: string[];
    try {
      const [diffResult, nameResult] = await Promise.all([
        readGit(git, "show", ["--format=", sha, "--", ...pathspec]),
        readGit(git, "show", [
          "--format=",
          "--name-only",
          sha,
          "--",
          ...pathspec,
        ]),
      ]);
      diff = diffResult.stdout.trim();
      files = nameResult.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith(skillPath))
        .map((line) => line.slice(skillPath.length))
        .filter((line) => line.length > 0);
    } catch (err) {
      log.warn({ err, skillId, sha }, "git show failed; skipping revision");
      continue;
    }
    // Nothing left once the usage stamp is excluded: the skill was loaded,
    // not changed.
    if (diff.length === 0 || files.length === 0) {
      continue;
    }
    revisions.push({ id: sha, changedAt, files, diff });
  }

  return {
    skillId,
    revisions,
    truncatedByCompaction: await hasCompactedHistory(git),
  };
}

/**
 * Whether the workspace has squashed older commits, which caps how far back
 * any skill's history can reach. Best-effort: an error here only means the
 * caller loses the caveat, never the history.
 */
async function hasCompactedHistory(
  git: ReturnType<typeof getWorkspaceGitService>,
): Promise<boolean> {
  try {
    const { stdout } = await readGit(git, "log", [
      "--format=%s",
      "--max-count=1",
      "--grep=Compacted workspace history",
    ]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
