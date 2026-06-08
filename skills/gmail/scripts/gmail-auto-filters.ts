#!/usr/bin/env bun

/**
 * Auto-generate Gmail filters from a completed inbox-cleanup run.
 *
 * Reads the op-log for a cleanup run, extracts patterns that are safe as
 * permanent filters, deduplicates against existing Gmail filters, and creates
 * new filters with `auto/*` labels. Bridges inbox-cleanup (drain backlog once)
 * and inbox-management (keep inbox clean on schedule).
 *
 * Subcommands:
 *   generate  — derive filters from a cleanup run, confirm with user, then create
 *   preview   — show what filters would be created without creating them
 */

import { parseArgs, printError, ok, optionalArg } from "./lib/common.js";
import { gmailGet, gmailPost } from "./lib/gmail-client.js";
import {
  readLog,
  generateRunId,
  writeStaged,
  writeCommitted,
  writeFailed,
  writeCompleted,
  listRuns,
  summarizeRun,
  type OpEntry,
} from "./lib/op-log.js";
import { loadPreferences } from "./gmail-prefs.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GmailFilterCriteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;
  hasAttachment?: boolean;
}

interface GmailFilterAction {
  addLabelIds?: string[];
  removeLabelIds?: string[];
  forward?: string;
}

interface GmailFilter {
  id: string;
  criteria: GmailFilterCriteria;
  action: GmailFilterAction;
}

interface FiltersListResponse {
  filter?: GmailFilter[];
}

interface GmailLabel {
  id: string;
  name: string;
}

interface LabelsListResponse {
  labels: GmailLabel[];
}

/** A filter candidate derived from cleanup patterns. */
interface FilterCandidate {
  /** Human-readable category name (e.g. "no-reply senders"). */
  category: string;
  /** The auto/* label to apply. */
  labelName: string;
  /** Gmail filter criteria. */
  criteria: GmailFilterCriteria;
  /** How many emails matched this pattern during cleanup. */
  matchCount: number;
}

// ---------------------------------------------------------------------------
// UI confirmation
// ---------------------------------------------------------------------------

/**
 * Request user confirmation via `assistant ui confirm`.
 * Blocks until the user approves, denies, or the request times out.
 */
async function requestConfirmation(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
}): Promise<boolean> {
  const args = [
    "assistant",
    "ui",
    "confirm",
    "--title",
    opts.title,
    "--message",
    opts.message,
    "--confirm-label",
    opts.confirmLabel ?? "Confirm",
    "--json",
  ];

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  try {
    const result = JSON.parse(stdout);
    return result.ok === true && result.confirmed === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Safe filter categories
// ---------------------------------------------------------------------------

/**
 * Derive filter candidates from a cleanup run's op-log entries.
 *
 * Only extracts patterns that the SKILL.md explicitly marks as safe for
 * permanent auto-archiving. Patterns like generic phrases or name/company
 * subject patterns are intentionally excluded — they're too broad.
 *
 * Detection is primarily phase-based because the cleanup archive writer
 * does not populate `from` or `subject` on staged entries — it only logs
 * `phase`, `reason`, and `message_ids`. When `from` is available (e.g.
 * enriched logs), it's used as a secondary signal for finer-grained filters.
 */
function deriveFilterCandidates(
  entries: OpEntry[],
  safelist: string[] = [],
): FilterCandidate[] {
  const candidates: FilterCandidate[] = [];

  let noReplyCount = 0;
  let calendarCount = 0;
  const sketchyTldCounts = new Map<string, number>();
  let newsletterCount = 0;
  const newsletterSenders = new Map<string, number>();

  const safelistLower = new Set(safelist.map((s) => s.toLowerCase()));

  for (const entry of entries) {
    if (entry.status !== "staged" || entry.op !== "archive") continue;

    const phase = entry.phase ?? "";
    const from = entry.from?.toLowerCase() ?? "";

    // Track no-reply senders (Pass 4) — phase is the primary signal since
    // the cleanup archive writer doesn't populate `from`.
    if (
      phase.includes("no_reply") ||
      phase.includes("noreply") ||
      (from && /\bno[-_]?reply\b/i.test(from)) ||
      (from && /\bdonotreply\b/i.test(from))
    ) {
      noReplyCount++;
    }

    // Track calendar noise (Pass 5) — phase-based; `subject` is rarely populated.
    if (
      phase.includes("calendar") ||
      /\b(accepted|declined|tentative):/i.test(entry.subject ?? "")
    ) {
      calendarCount++;
    }

    // Track sketchy TLDs (Pass 7) — phase-based detection.
    // When `from` is available, extract the domain for per-TLD filters.
    // Otherwise, count by phase to still produce the aggregate filter.
    if (phase.includes("sketchy") || phase.includes("tld")) {
      const domain = from ? extractDomain(from) : undefined;
      if (domain && isSketchyTld(domain)) {
        const tld = SKETCHY_TLDS_LIST.find((t) => domain.endsWith(t));
        if (tld) {
          sketchyTldCounts.set(tld, (sketchyTldCounts.get(tld) ?? 0) + 1);
        }
      } else {
        // No domain info — count toward a generic sketchy-TLD bucket
        sketchyTldCounts.set(
          "_generic",
          (sketchyTldCounts.get("_generic") ?? 0) + 1,
        );
      }
    }

    // Track newsletters (Pass 4) — phase-based detection.
    // When `from` is available, track per-sender for finer filters.
    if (phase.includes("newsletter") || phase.includes("digest")) {
      newsletterCount++;
      if (from) {
        newsletterSenders.set(from, (newsletterSenders.get(from) ?? 0) + 1);
      }
    }
  }

  // --- Build candidates from collected patterns ---

  // 1. No-reply / do-not-reply senders
  if (noReplyCount > 0) {
    candidates.push({
      category: "no-reply senders",
      labelName: "auto/no-reply",
      criteria: { from: "noreply OR no-reply OR donotreply" },
      matchCount: noReplyCount,
    });
  }

  // 2. Calendar responses
  if (calendarCount > 0) {
    candidates.push({
      category: "calendar responses",
      labelName: "auto/calendar",
      criteria: {
        query:
          'subject:(Accepted: OR Declined: OR Tentative: OR "has accepted" OR "has declined")',
      },
      matchCount: calendarCount,
    });
  }

  // 3. Sketchy TLD domains (one filter per TLD when domain data is available)
  const genericSketchyCount = sketchyTldCounts.get("_generic") ?? 0;
  for (const tld of SKETCHY_TLDS_LIST) {
    const count = sketchyTldCounts.get(tld) ?? 0;
    if (count > 0) {
      candidates.push({
        category: `sketchy TLD (${tld})`,
        labelName: "auto/sketchy-tld",
        criteria: { from: `*${tld}` },
        matchCount: count,
      });
    }
  }
  // If we had phase-tagged sketchy entries but no domain info, produce
  // per-TLD filters for all known sketchy TLDs as a catchall.
  if (
    genericSketchyCount > 0 &&
    candidates.every((c) => c.labelName !== "auto/sketchy-tld")
  ) {
    for (const tld of SKETCHY_TLDS_LIST) {
      candidates.push({
        category: `sketchy TLD (${tld})`,
        labelName: "auto/sketchy-tld",
        criteria: { from: `*${tld}` },
        matchCount: genericSketchyCount,
      });
    }
  }

  // 4. Newsletter senders — per-sender when `from` is available and not safelisted,
  //    otherwise a generic Unsubscribe-header filter.
  const confirmedNewsletters = [...newsletterSenders.entries()].filter(
    ([sender, count]) => count >= 2 && !safelistLower.has(sender),
  );
  if (confirmedNewsletters.length > 0) {
    for (const [sender] of confirmedNewsletters) {
      candidates.push({
        category: "newsletter",
        labelName: "auto/newsletter",
        criteria: { from: sender },
        matchCount: newsletterSenders.get(sender) ?? 0,
      });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractDomain(email: string): string | undefined {
  const atIndex = email.lastIndexOf("@");
  if (atIndex < 0) return undefined;
  return email.slice(atIndex + 1).toLowerCase();
}

const SKETCHY_TLDS_LIST = [
  ".shop",
  ".biz",
  ".xyz",
  ".info",
  ".club",
  ".online",
];
const SKETCHY_TLDS = new Set(SKETCHY_TLDS_LIST);

function isSketchyTld(domain: string): boolean {
  for (const tld of SKETCHY_TLDS) {
    if (domain.endsWith(tld)) return true;
  }
  return false;
}

/** Check if an existing filter already covers the same criteria. */
function isDuplicateFilter(
  candidate: FilterCandidate,
  existing: GmailFilter[],
): boolean {
  for (const filter of existing) {
    const c = filter.criteria;
    const target = candidate.criteria;

    if (target.from && c.from && c.from === target.from) return true;
    if (target.query && c.query && c.query === target.query) return true;
    if (target.subject && c.subject && c.subject === target.subject)
      return true;
  }
  return false;
}

/** Format filter candidates into a human-readable confirmation message. */
function formatFilterPlan(candidates: FilterCandidate[]): string {
  const lines: string[] = [`${candidates.length} filter(s) will be created:\n`];
  for (const c of candidates) {
    const criteria = c.criteria.from
      ? `from: ${c.criteria.from}`
      : c.criteria.query
        ? `query: ${c.criteria.query}`
        : `subject: ${c.criteria.subject}`;
    lines.push(
      `  - ${c.category} (${c.matchCount} emails caught during cleanup)`,
    );
    lines.push(`    ${criteria}`);
    lines.push(`    label: ${c.labelName}, action: skip inbox`);
  }
  lines.push(
    "\nMatching emails will be labeled and auto-archived going forward.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Label management
// ---------------------------------------------------------------------------

async function getOrCreateLabel(
  name: string,
  account?: string,
): Promise<string> {
  const res = await gmailGet<LabelsListResponse>("/labels", undefined, account);
  if (!res.ok) {
    printError(`Failed to list labels (HTTP ${res.status})`);
  }

  const existing = (res.data.labels ?? []).find((l) => l.name === name);
  if (existing) return existing.id;

  const createRes = await gmailPost<GmailLabel>(
    "/labels",
    {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
    account,
  );
  if (!createRes.ok) {
    printError(`Failed to create label "${name}" (HTTP ${createRes.status})`);
  }
  return createRes.data.id;
}

// ---------------------------------------------------------------------------
// Find latest completed cleanup run
// ---------------------------------------------------------------------------

/**
 * Find the most recent completed cleanup run that contains archive ops.
 *
 * Skips filter-creation runs (produced by this script's `generate` command)
 * so that auto-detection doesn't pick up its own output as input.
 */
function findLatestCleanupRun(): string | null {
  const runs = listRuns();
  for (const runId of runs) {
    const summary = summarizeRun(runId);
    if (!summary) continue;
    if (summary.status !== "completed" || summary.total_committed <= 0)
      continue;

    // A cleanup run must contain at least one staged archive op.
    // Filter-creation runs only contain filter_create ops, so they're skipped.
    const entries = readLog(runId);
    const hasArchiveOps = entries.some(
      (e) => e.status === "staged" && e.op === "archive",
    );
    if (hasArchiveOps) {
      return runId;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handleGenerate(
  args: Record<string, string | boolean>,
): Promise<void> {
  const account = optionalArg(args, "account");
  const dryRun = args["dry-run"] === true;
  const skipConfirm = args["skip-confirm"] === true;
  const sourceRunId = optionalArg(args, "run-id") ?? findLatestCleanupRun();

  if (!sourceRunId) {
    printError(
      "No completed cleanup run found. Run inbox-cleanup first, or pass --run-id explicitly.",
    );
  }

  // Read cleanup op-log
  const entries = readLog(sourceRunId!);
  if (entries.length === 0) {
    printError(`No op-log entries found for run ${sourceRunId}.`);
  }

  // Load preferences for safelist cross-referencing
  const prefs = loadPreferences();

  // Derive safe filter candidates (safelist excludes user-protected senders)
  const candidates = deriveFilterCandidates(entries, prefs.safelist);
  if (candidates.length === 0) {
    ok({
      message: "No safe filter candidates found in cleanup run.",
      source_run_id: sourceRunId,
      candidates: [],
    });
    return;
  }

  // Fetch existing filters for dedup
  const existingRes = await gmailGet<FiltersListResponse>(
    "/settings/filters",
    undefined,
    account,
  );
  if (!existingRes.ok) {
    printError(`Failed to list existing filters (HTTP ${existingRes.status})`);
  }
  const existingFilters = existingRes.data.filter ?? [];

  // Filter out duplicates
  const newCandidates = candidates.filter(
    (c) => !isDuplicateFilter(c, existingFilters),
  );

  if (newCandidates.length === 0) {
    ok({
      message:
        "All filter candidates already covered by existing Gmail filters.",
      source_run_id: sourceRunId,
      candidates_considered: candidates.length,
      duplicates_skipped: candidates.length,
    });
    return;
  }

  // Dry-run: show plan without creating
  if (dryRun) {
    ok({
      dry_run: true,
      source_run_id: sourceRunId,
      would_create: newCandidates.map((c) => ({
        category: c.category,
        label: c.labelName,
        criteria: c.criteria,
        cleanup_matches: c.matchCount,
      })),
      duplicates_skipped: candidates.length - newCandidates.length,
    });
    return;
  }

  // Always confirm with the user before creating filters
  if (!skipConfirm) {
    const confirmed = await requestConfirmation({
      title: "Create inbox filters",
      message: formatFilterPlan(newCandidates),
      confirmLabel: "Create filters",
    });
    if (!confirmed) {
      ok({
        cancelled: true,
        source_run_id: sourceRunId,
        message: "Filter creation cancelled by user.",
      });
      return;
    }
  }

  // Create filters
  const filterRunId = generateRunId();
  const created: Array<{
    category: string;
    label: string;
    filter_id: string;
  }> = [];
  let committed = 0;
  let failed = 0;

  // Resolve unique label names to Gmail label IDs
  const labelNames = [...new Set(newCandidates.map((c) => c.labelName))];
  const labelIdMap = new Map<string, string>();
  for (const name of labelNames) {
    const labelId = await getOrCreateLabel(name, account);
    labelIdMap.set(name, labelId);
  }

  for (let i = 0; i < newCandidates.length; i++) {
    const candidate = newCandidates[i];
    const labelId = labelIdMap.get(candidate.labelName)!;

    writeStaged({
      run_id: filterRunId,
      phase: "auto_filter",
      op: "filter_create",
      chunk_index: i,
      message_ids: [],
      reason: JSON.stringify({
        category: candidate.category,
        criteria: candidate.criteria,
        label: candidate.labelName,
      }),
    });

    try {
      const res = await gmailPost<GmailFilter>(
        "/settings/filters",
        {
          criteria: candidate.criteria,
          action: {
            addLabelIds: [labelId],
            removeLabelIds: ["INBOX"],
          },
        },
        account,
      );

      if (!res.ok) {
        writeFailed(filterRunId, i, `HTTP ${res.status}`);
        failed++;
        continue;
      }

      writeCommitted(filterRunId, i);
      committed++;
      created.push({
        category: candidate.category,
        label: candidate.labelName,
        filter_id: res.data.id,
      });
    } catch (err) {
      writeFailed(
        filterRunId,
        i,
        err instanceof Error ? err.message : String(err),
      );
      failed++;
    }
  }

  writeCompleted(filterRunId, committed, failed);

  ok({
    source_run_id: sourceRunId,
    filter_run_id: filterRunId,
    created,
    committed,
    failed,
    duplicates_skipped: candidates.length - newCandidates.length,
    labels_created: labelNames,
    how_to_find: `Search Gmail by label (e.g. "label:auto/no-reply") to see auto-archived emails.`,
    how_to_remove: `Use: bun run scripts/gmail-manage.ts filters --action delete --filter-id "<id>"`,
  });
}

// ---------------------------------------------------------------------------
// CLI dispatcher
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const subcommand = rawArgs[0];
  const args = parseArgs(rawArgs.slice(1));

  switch (subcommand) {
    case "generate":
      await handleGenerate(args);
      break;
    case "preview":
      await handleGenerate({ ...args, "dry-run": true });
      break;
    default:
      printError(
        `Unknown subcommand: ${subcommand ?? "(none)"}. Expected: generate, preview`,
      );
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
  }
}
