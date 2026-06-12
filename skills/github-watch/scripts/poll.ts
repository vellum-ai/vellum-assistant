/**
 * github-watch poll script — runs from a script-mode (tokenless) schedule.
 *
 * Polls the GitHub Notifications API via `assistant oauth request` (tokens are
 * injected transparently by the CLI; this script never sees credentials),
 * filters to relevant notification reasons, dedups against previously seen
 * notification ids, and wakes the configured conversation only when new
 * relevant notifications exist. Quiet polls exit 0 with no output and cost
 * zero LLM tokens.
 *
 * Usage:
 *   bun run poll.ts <state-dir>              # normal poll
 *   bun run poll.ts <state-dir> --validate   # parse config/state and exit (no daemon calls)
 *
 * State directory layout:
 *   config.json  { "conversationId": "<id>" }            — written at setup time
 *   state.json   { "watermark": "<ISO>", "seenIds": [] }  — managed by this script
 *
 * Mirrors the relevance filter and watermark semantics of the built-in GitHub
 * watcher provider (assistant/src/watcher/providers/github.ts): only the
 * reasons assign / mention / review_requested / team_mention surface, the
 * `since` watermark starts at "now" on first run (no historical replay), and
 * each successful poll advances the watermark to the fetch start time.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Constants ──────────────────────────────────────────────────────────────

const RELEVANT_REASONS = new Set([
  "assign",
  "mention",
  "review_requested",
  "team_mention",
]);
const PER_PAGE = 50;
const MAX_PAGES = 10; // safety bound; the built-in watcher pages unbounded
const MAX_SEEN_IDS = 500;
const MAX_HINT_ITEMS = 10;

// ── Types ──────────────────────────────────────────────────────────────────

interface Config {
  conversationId: string;
}

interface State {
  watermark: string; // ISO 8601 — value for the `since` query param
  seenIds: string[];
}

interface GitHubNotification {
  id: string;
  reason: string;
  updated_at: string;
  subject: {
    title: string;
    type: string;
    url: string | null;
  };
  repository: {
    full_name: string;
  };
}

// ── Small helpers ──────────────────────────────────────────────────────────

function fail(message: string): never {
  process.stderr.write(`github-watch poll: ${message}\n`);
  process.exit(1);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Flatten external text into a single safe-ish line for the wake hint. */
function sanitizeLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").trim();
}

function readJsonFile<T>(path: string, label: string): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    fail(`cannot read ${label} at ${path}: ${String(err)}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    fail(`invalid JSON in ${label} at ${path}: ${String(err)}`);
  }
}

// ── Assistant CLI invocation ───────────────────────────────────────────────

/** Run the `assistant` CLI and return parsed JSON stdout. */
function runAssistantJson(args: string[]): unknown {
  const proc = Bun.spawnSync(["assistant", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  if (!stdout.trim()) {
    fail(
      `\`assistant ${args[0]} ${args[1] ?? ""}\` produced no output ` +
        `(exit ${proc.exitCode}). stderr: ${truncate(stderr, 500)}`,
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    fail(
      `\`assistant ${args[0]}\` emitted non-JSON output: ${truncate(
        stdout,
        500,
      )}`,
    );
  }
}

// ── GitHub polling ─────────────────────────────────────────────────────────

interface OauthRequestResult {
  ok: boolean;
  status: number;
  body: unknown;
  error?: string;
  hint?: string;
}

function fetchNotificationsPage(
  since: string,
  page: number,
): GitHubNotification[] {
  const query = `all=false&since=${encodeURIComponent(
    since,
  )}&per_page=${PER_PAGE}&page=${page}`;
  const result = runAssistantJson([
    "oauth",
    "request",
    "--provider",
    "github",
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "X-GitHub-Api-Version: 2022-11-28",
    "-s",
    "--json",
    `/notifications?${query}`,
  ]) as OauthRequestResult;

  if (!result.ok && result.error) {
    fail(`oauth request failed: ${result.error}`);
  }
  if (result.status < 200 || result.status >= 300) {
    fail(
      `GitHub Notifications API returned ${result.status}: ` +
        truncate(JSON.stringify(result.body), 500),
    );
  }
  if (!Array.isArray(result.body)) {
    fail(`unexpected notifications response shape (expected array)`);
  }
  return result.body as GitHubNotification[];
}

function fetchRelevantSince(since: string): GitHubNotification[] {
  const relevant: GitHubNotification[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = fetchNotificationsPage(since, page);
    for (const n of items) {
      if (RELEVANT_REASONS.has(n.reason)) relevant.push(n);
    }
    if (items.length < PER_PAGE) break; // last page
  }
  return relevant;
}

// ── Escalation ─────────────────────────────────────────────────────────────

function describeNotification(n: GitHubNotification): string {
  const reason = n.reason.replace(/_/g, " ");
  const title = sanitizeLine(truncate(n.subject.title, 80));
  return `[${reason}] ${n.subject.type} in ${n.repository.full_name}: ${title}`;
}

function buildHint(items: GitHubNotification[]): string {
  const lines = items.slice(0, MAX_HINT_ITEMS).map(describeNotification);
  const more =
    items.length > MAX_HINT_ITEMS
      ? ` (+${items.length - MAX_HINT_ITEMS} more)`
      : "";
  return (
    `GitHub watch: ${items.length} new notification(s) for the user${more}. ` +
    `Summarize them and surface anything that needs the user's attention. ` +
    `Details: ${lines.join(" | ")}`
  );
}

interface WakeResult {
  ok: boolean;
  invoked?: boolean;
  reason?: "not_found" | "archived" | "timeout" | "no_resolver";
  error?: string;
}

/**
 * Deliver the hint. Returns true when delivery succeeded (or a fallback
 * notification was sent), false when delivery should be retried next poll.
 */
function deliver(conversationId: string, items: GitHubNotification[]): boolean {
  const hint = buildHint(items);
  const wake = runAssistantJson([
    "conversations",
    "wake",
    conversationId,
    "--hint",
    hint,
    "--source",
    "github-watch",
    "--json",
  ]) as WakeResult;

  if (wake.ok && wake.invoked) {
    process.stdout.write(
      `Woke conversation ${conversationId} with ${items.length} notification(s)\n`,
    );
    return true;
  }

  if (wake.reason === "timeout") {
    // Conversation busy — retry on the next poll without losing events.
    process.stderr.write(
      `Conversation ${conversationId} busy; will retry next poll\n`,
    );
    return false;
  }

  // Archived / not found / IPC error — fall back to a plain notification.
  process.stderr.write(
    `Wake failed (${wake.reason ?? wake.error ?? "unknown"}); ` +
      `falling back to notifications send\n`,
  );
  const lines = items.slice(0, MAX_HINT_ITEMS).map(describeNotification);
  const send = Bun.spawnSync(
    [
      "assistant",
      "notifications",
      "send",
      "--title",
      "New GitHub notifications",
      "--message",
      `${items.length} new GitHub notification(s):\n${lines.join("\n")}`,
      "--source-event-name",
      "github-watch.poll",
      "--dedupe-key",
      `github-watch-${items[0]!.id}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (send.exitCode !== 0) {
    process.stderr.write(
      `notifications send failed: ${truncate(send.stderr.toString(), 500)}\n`,
    );
    return false;
  }
  process.stdout.write(`Sent fallback notification (wake unavailable)\n`);
  return true;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const validate = args.includes("--validate");
  const stateDir = args.find((a) => !a.startsWith("--"));
  if (!stateDir) {
    fail("usage: bun run poll.ts <state-dir> [--validate]");
  }

  const configPath = join(stateDir, "config.json");
  const statePath = join(stateDir, "state.json");

  if (!existsSync(configPath)) {
    fail(`missing config at ${configPath} — re-run the github-watch setup`);
  }
  const config = readJsonFile<Config>(configPath, "config.json");
  if (!config.conversationId || typeof config.conversationId !== "string") {
    fail(`config.json must contain a string "conversationId"`);
  }

  const hasState = existsSync(statePath);
  const state: State = hasState
    ? readJsonFile<State>(statePath, "state.json")
    : { watermark: new Date().toISOString(), seenIds: [] };
  if (typeof state.watermark !== "string" || !Array.isArray(state.seenIds)) {
    fail(`state.json must contain "watermark" (string) and "seenIds" (array)`);
  }

  if (validate) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        stateDir,
        conversationId: config.conversationId,
        watermark: state.watermark,
        seenIds: state.seenIds.length,
        initialized: hasState,
      }) + "\n",
    );
    return;
  }

  if (!hasState) {
    // First poll: capture "now" as the watermark so we don't replay history
    // (mirrors the built-in watcher's getInitialWatermark).
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
    process.stdout.write(`Initialized watermark at ${state.watermark}\n`);
    return;
  }

  // Capture the fetch start time before polling so events arriving mid-poll
  // are picked up next cycle (same semantics as the built-in watcher).
  const fetchStart = new Date().toISOString();

  const relevant = fetchRelevantSince(state.watermark);
  const seen = new Set(state.seenIds);
  const fresh = relevant.filter((n) => !seen.has(n.id));

  if (fresh.length > 0) {
    const delivered = deliver(config.conversationId, fresh);
    if (!delivered) {
      // Leave state untouched so the next poll retries these events.
      process.exit(1);
    }
  }

  const mergedSeen = [...state.seenIds, ...fresh.map((n) => n.id)].slice(
    -MAX_SEEN_IDS,
  );
  const nextState: State = { watermark: fetchStart, seenIds: mergedSeen };
  writeFileSync(statePath, JSON.stringify(nextState, null, 2) + "\n", "utf-8");
  // Quiet poll: no new events → no output, exit 0, zero tokens spent.
}

main();
