/**
 * The copy contract, enforced as a pre-send pass rather than a style guide.
 *
 * Every notification answers three questions in order: **what happened**
 * (title), **why you care** (first line of body), **what to do** (an action,
 * or nothing). The rules that make that legible:
 *
 *   - The title is a noun phrase, at most 8 words, and never starts with "I".
 *   - The title is not a prefix of the body.
 *   - The body carries no raw error constants.
 *   - A needs-you row with no action is a bug.
 *
 * **Repair, then reject.** The pass rewrites what it can fix deterministically
 * and only fails when nothing usable is left. A dropped approval costs the
 * user the exact thing the top section exists for, so suppressing one because
 * a model opened its title with "I" would trade a copy defect for a
 * correctness defect. Everything the pass rewrites, and every violation it
 * cannot rewrite, is reported so the producers behind them can be fixed.
 */

import type { FeedItemBucket } from "../api/responses/home.js";
import { getLogger } from "../util/logger.js";
import { deriveBucket } from "./bucket.js";
import type { NotificationSignal } from "./signal.js";
import type {
  NotificationChannel,
  NotificationDecision,
  RenderedChannelCopy,
} from "./types.js";

const log = getLogger("notification-copy-contract");

/** Ceiling on title length, in words. */
export const TITLE_MAX_WORDS = 8;

/**
 * Screaming-snake tokens of three or more segments, the shape raw error
 * constants take here (`PROVIDER_API`, `TOOL_APPROVAL_TIMED_OUT`). Two-segment
 * tokens are excluded on purpose: ordinary copy contains acronyms and product
 * names that would match (`API_KEY` reads fine in "Add an API_KEY"), and the
 * cure would be worse than the disease.
 */
const RAW_ERROR_CONSTANT = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b/g;

/**
 * A leading first-person clause, the tell of a title sliced off the front of
 * a first-person body ("I wrote something about the renderer…"). Matching the
 * opening word alone is enough: a title starting "I" is never a noun phrase.
 */
const LEADING_FIRST_PERSON = /^i(?:'|\s|$)/i;

export type CopyContractViolation =
  | "title_first_person"
  | "title_too_long"
  | "title_prefixes_body"
  | "title_missing"
  | "body_raw_error_constant"
  | "body_missing"
  | "needs_you_without_action";

export interface CopyContractResult {
  /** The repaired copy, or `null` when nothing usable survived. */
  copy: RenderedChannelCopy | null;
  violations: CopyContractViolation[];
}

export interface CopyContractContext {
  bucket: FeedItemBucket;
  /** Whether the surface this copy lands on offers the user something to do. */
  hasAction: boolean;
  /** Only used for logging, so a violation points at its producer. */
  sourceEventName: string;
}

/**
 * Apply the contract to one channel's rendered copy.
 *
 * Never throws. Returns `copy: null` only when the body is unusable, which is
 * the one defect no rewrite can cover: a notification with nothing to say.
 */
export function applyCopyContract(
  copy: RenderedChannelCopy,
  context: CopyContractContext,
): CopyContractResult {
  const violations: CopyContractViolation[] = [];

  const body = copy.body?.trim() ?? "";
  if (body.length === 0) {
    violations.push("body_missing");
    report(violations, context);
    return { copy: null, violations };
  }

  let repairedBody = body;
  if (RAW_ERROR_CONSTANT.test(body)) {
    violations.push("body_raw_error_constant");
    repairedBody = stripRawErrorConstants(body);
  }
  // `RAW_ERROR_CONSTANT` is a global regex, so its `lastIndex` survives a
  // `test` and would make the next call start mid-string.
  RAW_ERROR_CONSTANT.lastIndex = 0;

  const title = repairTitle(copy.title ?? "", repairedBody, violations);
  if (title === null) {
    violations.push("title_missing");
  }

  if (context.bucket === "needs_you" && !context.hasAction) {
    violations.push("needs_you_without_action");
  }

  report(violations, context);

  return {
    copy: {
      ...copy,
      ...(title !== null ? { title } : { title: "" }),
      body: repairedBody,
    },
    violations,
  };
}

/**
 * Bring a title inside the contract, or return `null` when nothing is left of
 * it. A `null` title is not fatal: surfaces fall back to the body, which is
 * the honest rendering of a notification whose headline was never written.
 */
function repairTitle(
  raw: string,
  body: string,
  violations: CopyContractViolation[],
): string | null {
  let title = raw.trim().replace(/\s+/g, " ");
  if (title.length === 0) {
    return null;
  }

  if (LEADING_FIRST_PERSON.test(title)) {
    violations.push("title_first_person");
    return null;
  }

  // Checked before the word trim so a long title truncated down to a prefix
  // of the body is caught by the same rule that catches a short one.
  if (isPrefixOfBody(title, body)) {
    violations.push("title_prefixes_body");
    return null;
  }

  const words = title.split(" ");
  if (words.length > TITLE_MAX_WORDS) {
    violations.push("title_too_long");
    // Trailing punctuation left behind by the cut reads as a truncation
    // artifact, which is the thing the rule exists to stop looking like.
    title = words.slice(0, TITLE_MAX_WORDS).join(" ").replace(/[,;:—-]+$/, "");
  }

  return title.length > 0 ? title : null;
}

/**
 * Whether the title is the opening of the body rather than a headline for it.
 *
 * Compared on collapsed, case-folded, punctuation-stripped text so the
 * trailing ellipsis a slice leaves behind does not hide the match.
 */
function isPrefixOfBody(title: string, body: string): boolean {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const normalizedTitle = normalize(title);
  if (normalizedTitle.length === 0) {
    return false;
  }
  return normalize(body).startsWith(normalizedTitle);
}

/**
 * Remove raw error constants and the punctuation that framed them, then
 * tidy the seams so the body still reads as a sentence.
 */
function stripRawErrorConstants(body: string): string {
  return body
    .replace(RAW_ERROR_CONSTANT, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

/**
 * Apply the contract to every channel's copy on a decision, returning the
 * decision to dispatch.
 *
 * Runs before the deterministic pre-send checks, so a channel whose body the
 * contract could not save is dropped from `selectedChannels` and the existing
 * channel-availability check decides what that means for the signal as a whole.
 * The decision is rebuilt rather than mutated: it has already been persisted
 * for the audit trail, and rewriting it under the audit is how a stored
 * decision stops matching what shipped.
 */
export function applyCopyContractToDecision(
  signal: NotificationSignal,
  decision: NotificationDecision,
): NotificationDecision {
  if (!decision.shouldNotify) {
    return decision;
  }

  const bucket = deriveBucket(signal);
  const renderedCopy: NotificationDecision["renderedCopy"] = {};
  const selectedChannels: NotificationChannel[] = [];

  for (const channel of decision.selectedChannels) {
    const copy = decision.renderedCopy[channel];
    if (!copy) {
      // No copy from the decision engine: the broadcaster's template fallback
      // will compose it at delivery time, and the contract has nothing to
      // check yet. The channel stays selected.
      selectedChannels.push(channel);
      continue;
    }
    const result = applyCopyContract(copy, {
      bucket,
      // Channel-side actions are attached downstream by the broadcaster's
      // context resolvers, so an interactive card is assumed for the buckets
      // that ship one. The needs-you-without-action rule is really about
      // producers that emit a blocking signal with nothing to answer it, and
      // that is what the deep-link check below catches.
      hasAction: bucket !== "needs_you" || signal.requiresConversation === true,
      sourceEventName: signal.sourceEventName,
    });
    if (!result.copy) {
      continue;
    }
    renderedCopy[channel] = result.copy;
    selectedChannels.push(channel);
  }

  if (
    selectedChannels.length === decision.selectedChannels.length &&
    selectedChannels.every((c) => decision.renderedCopy[c] === renderedCopy[c])
  ) {
    return decision;
  }

  return { ...decision, selectedChannels, renderedCopy };
}

function report(
  violations: CopyContractViolation[],
  context: CopyContractContext,
): void {
  if (violations.length === 0) {
    return;
  }
  log.warn(
    {
      violations,
      sourceEventName: context.sourceEventName,
      bucket: context.bucket,
    },
    "Notification copy violated the copy contract",
  );
}
