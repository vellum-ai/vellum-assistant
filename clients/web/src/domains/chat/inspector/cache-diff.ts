/**
 * Pure cache-diff logic for the Prompt tab. Compares the normalized
 * request sections of the *current* LLM call against the *previous*
 * turn's call and decides which logical block most likely busted the
 * prompt cache — the "your cache broke here because §X changed" answer.
 *
 * Why compare by logical group rather than raw section position: the
 * normalizer emits sections in display order (system → messages →
 * tools → settings) and the message list grows every turn, so a
 * position-based alignment would mis-align tools/settings against
 * messages across turns. Instead we bucket sections into stable groups
 * (system / tools / settings / messages), align the message group from
 * the front, and report the highest-priority changed group following
 * the provider cache-prefix order (model → tools → system → messages).
 *
 * This module is provider-agnostic and side-effect free so it can be
 * unit-tested in isolation; the {@link CacheDiffCard} component owns all
 * data fetching and presentation.
 */

import type { LLMContextSection } from "@vellumai/assistant-api";

/**
 * Which block changed first, in cache-prefix priority order. `none`
 * means the cached prefix is intact and only new messages were appended
 * (a miss then points at TTL expiry, not changed content); `no-previous`
 * means there is no earlier call to diff against.
 */
export type CacheDiffCause =
  | "model"
  | "tools"
  | "system"
  | "messages"
  | "settings"
  | "none"
  | "no-previous";

export interface CacheDiffLine {
  type: "context" | "added" | "removed";
  text: string;
}

/**
 * A line-diff entry after collapsing long unchanged runs: either a real
 * diff line or a `gap` marker standing in for `count` hidden context
 * lines.
 */
export type CollapsedDiffEntry =
  | { type: "line"; line: CacheDiffLine }
  | { type: "gap"; count: number };

/** Per-group change flags, independent of which one is the headline cause. */
export interface CacheDiffChangedGroups {
  model: boolean;
  tools: boolean;
  system: boolean;
  messages: boolean;
  settings: boolean;
}

export interface CacheDiffResult {
  cause: CacheDiffCause;
  changedGroups: CacheDiffChangedGroups;
  previousModel: string | null;
  currentModel: string | null;
  /** Count of leading messages identical to the previous turn. */
  sharedMessageCount: number;
  /** Messages present this turn but not the previous one. */
  appendedMessageCount: number;
  /** Messages present last turn but gone now (likely compaction). */
  removedMessageCount: number;
  /** Index within the message group of the first divergent message, or -1. */
  firstChangedMessageIndex: number;
  /** Human label (role or kind) of the first divergent message, if any. */
  changedMessageLabel: string | null;
  /** Optional line-level diff for a text change (system or a message). */
  lineDiff: CacheDiffLine[] | null;
  /** True when the text was too large to diff and was skipped. */
  lineDiffTruncated: boolean;
  /** Heading for the line diff, e.g. "System prompt" or "user message". */
  lineDiffLabel: string | null;
}

/** Resolved inputs for one call: its request sections plus the model id. */
export interface CacheDiffInput {
  sections: LLMContextSection[];
  model: string | null | undefined;
}

/** Largest line count we will run the O(n·m) LCS diff over before bailing. */
const MAX_DIFF_LINES = 500;

type GroupKind = "system" | "tools" | "settings" | "messages";

function groupOf(section: LLMContextSection): GroupKind {
  if (section.kind === "system") return "system";
  if (section.kind === "tool_definitions") return "tools";
  if (section.kind === "settings") return "settings";
  return "messages";
}

/**
 * Recursively sorts object keys so two structurally equal payloads
 * stringify identically regardless of key insertion order — avoids
 * false-positive diffs from key reordering.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
  }
  return value;
}

/**
 * Stable content fingerprint for a single section. Includes `toolName`
 * because tool-call and tool-result sections can carry identical
 * `text`/`data` while targeting different tools — without it a tool
 * swap inside the cached prefix would hash identically and the diff
 * would wrongly report the prefix as unchanged.
 */
function sectionSignature(section: LLMContextSection): string {
  return JSON.stringify({
    kind: section.kind,
    role: section.role ?? null,
    text: section.text ?? null,
    toolName: section.toolName ?? null,
    data: sortKeysDeep(section.data),
  });
}

function joinSignatures(sections: LLMContextSection[]): string {
  return sections.map(sectionSignature).join("\u0000");
}

function describeSection(section: LLMContextSection): string {
  if (section.role) return `${section.role} message`;
  return section.kind.replace(/_/g, " ");
}

/**
 * Line-level diff via longest-common-subsequence. Returns `null` when
 * the texts are identical, and a truncated marker when either side
 * exceeds {@link MAX_DIFF_LINES} so the quadratic table stays bounded.
 */
export function diffLines(
  previousText: string,
  currentText: string,
): { lines: CacheDiffLine[]; truncated: boolean } | null {
  if (previousText === currentText) return null;

  const a = previousText.split("\n");
  const b = currentText.split("\n");
  if (Math.max(a.length, b.length) > MAX_DIFF_LINES) {
    return { lines: [], truncated: true };
  }

  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: CacheDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push({ type: "context", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: "removed", text: a[i] });
      i++;
    } else {
      lines.push({ type: "added", text: b[j] });
      j++;
    }
  }
  while (i < m) lines.push({ type: "removed", text: a[i++] });
  while (j < n) lines.push({ type: "added", text: b[j++] });
  return { lines, truncated: false };
}

/**
 * Compares the current call's request sections against the previous
 * turn's and returns the most likely cache-bust cause plus supporting
 * detail for the UI. Pass `previous` as `null` for the first call in a
 * conversation; the result's `cause` is then `"no-previous"`.
 */
export function computeCacheDiff(
  current: CacheDiffInput,
  previous: CacheDiffInput | null,
): CacheDiffResult {
  const emptyGroups: CacheDiffChangedGroups = {
    model: false,
    tools: false,
    system: false,
    messages: false,
    settings: false,
  };

  if (!previous) {
    return {
      cause: "no-previous",
      changedGroups: emptyGroups,
      previousModel: null,
      currentModel: current.model ?? null,
      sharedMessageCount: 0,
      appendedMessageCount: 0,
      removedMessageCount: 0,
      firstChangedMessageIndex: -1,
      changedMessageLabel: null,
      lineDiff: null,
      lineDiffTruncated: false,
      lineDiffLabel: null,
    };
  }

  const curSystem = current.sections.filter((s) => groupOf(s) === "system");
  const prevSystem = previous.sections.filter((s) => groupOf(s) === "system");
  const curTools = current.sections.filter((s) => groupOf(s) === "tools");
  const prevTools = previous.sections.filter((s) => groupOf(s) === "tools");
  const curSettings = current.sections.filter((s) => groupOf(s) === "settings");
  const prevSettings = previous.sections.filter(
    (s) => groupOf(s) === "settings",
  );
  const curMessages = current.sections.filter((s) => groupOf(s) === "messages");
  const prevMessages = previous.sections.filter(
    (s) => groupOf(s) === "messages",
  );

  const modelChanged =
    (current.model ?? null) !== (previous.model ?? null) &&
    Boolean(current.model || previous.model);
  const toolsChanged = joinSignatures(curTools) !== joinSignatures(prevTools);
  const systemChanged =
    joinSignatures(curSystem) !== joinSignatures(prevSystem);
  const settingsChanged =
    joinSignatures(curSettings) !== joinSignatures(prevSettings);

  const sharedLimit = Math.min(curMessages.length, prevMessages.length);
  let sharedMessageCount = 0;
  while (
    sharedMessageCount < sharedLimit &&
    sectionSignature(curMessages[sharedMessageCount]) ===
      sectionSignature(prevMessages[sharedMessageCount])
  ) {
    sharedMessageCount++;
  }
  const firstChangedMessageIndex =
    sharedMessageCount < sharedLimit ? sharedMessageCount : -1;
  const appendedMessageCount = Math.max(
    curMessages.length - prevMessages.length,
    0,
  );
  const removedMessageCount = Math.max(
    prevMessages.length - curMessages.length,
    0,
  );
  const messagesChanged = firstChangedMessageIndex >= 0 || removedMessageCount > 0;

  const changedGroups: CacheDiffChangedGroups = {
    model: modelChanged,
    tools: toolsChanged,
    system: systemChanged,
    messages: messagesChanged,
    settings: settingsChanged,
  };

  let cause: CacheDiffCause = "none";
  if (modelChanged) cause = "model";
  else if (toolsChanged) cause = "tools";
  else if (systemChanged) cause = "system";
  else if (messagesChanged) cause = "messages";
  else if (settingsChanged) cause = "settings";

  let changedMessageLabel: string | null = null;
  let lineDiff: CacheDiffLine[] | null = null;
  let lineDiffTruncated = false;
  let lineDiffLabel: string | null = null;

  if (cause === "system") {
    const result = diffLines(
      prevSystem.map((s) => s.text ?? "").join("\n"),
      curSystem.map((s) => s.text ?? "").join("\n"),
    );
    if (result) {
      lineDiff = result.lines;
      lineDiffTruncated = result.truncated;
      lineDiffLabel = "System prompt";
    }
  } else if (cause === "messages" && firstChangedMessageIndex >= 0) {
    const changed = curMessages[firstChangedMessageIndex];
    changedMessageLabel = describeSection(changed);
    const prior = prevMessages[firstChangedMessageIndex];
    if (
      prior &&
      prior.kind === changed.kind &&
      changed.text != null &&
      prior.text != null
    ) {
      const result = diffLines(prior.text, changed.text);
      if (result) {
        lineDiff = result.lines;
        lineDiffTruncated = result.truncated;
        lineDiffLabel = describeSection(changed);
      }
    }
  }

  return {
    cause,
    changedGroups,
    previousModel: previous.model ?? null,
    currentModel: current.model ?? null,
    sharedMessageCount,
    appendedMessageCount,
    removedMessageCount,
    firstChangedMessageIndex,
    changedMessageLabel,
    lineDiff,
    lineDiffTruncated,
    lineDiffLabel,
  };
}

/**
 * Collapses long runs of unchanged context in a line diff into `gap`
 * markers, keeping `padding` context lines on each side of every change
 * so the rendered diff reads as focused hunks rather than a wall of
 * identical text. A diff with no changes collapses to a single gap.
 */
export function collapseDiffContext(
  lines: CacheDiffLine[],
  padding = 2,
): CollapsedDiffEntry[] {
  const keep: boolean[] = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.type === "context") return;
    const start = Math.max(0, index - padding);
    const end = Math.min(lines.length - 1, index + padding);
    for (let j = start; j <= end; j++) keep[j] = true;
  });

  const entries: CollapsedDiffEntry[] = [];
  let gap = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (gap > 0) {
        entries.push({ type: "gap", count: gap });
        gap = 0;
      }
      entries.push({ type: "line", line: lines[i] });
    } else {
      gap++;
    }
  }
  if (gap > 0) entries.push({ type: "gap", count: gap });
  return entries;
}
