/**
 * GitHub watcher (script-mode schedule). Polls notifications via the daemon's
 * OAuth proxy, keeps a cursor under `./state/`, and wakes a fresh conversation
 * only when there's new activity — empty polls cost no LLM tokens. Runs with cwd
 * at the schedule's own dir. Self-contained: built-ins + the `assistant` CLI.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

const STATE_DIR = "state";
const STATE_FILE = "state/state.json";

// TRUSTED framing you authored. Raw GitHub data rides the fenced
// --external-content channel below, never this line. Edit to taste.
const ACTION_PROMPT =
  "New GitHub activity arrived. Summarize what's new — review requests, " +
  "mentions, assignments — grouped by repo, and flag anything time-sensitive.";

// Notification reasons worth surfacing.
const RELEVANT_REASONS = new Set([
  "assign",
  "mention",
  "review_requested",
  "team_mention",
]);
const SEEN_CAP = 1000;

interface State {
  since: string;
  seen: string[];
}

interface GhNotification {
  id: string;
  reason: string;
  updated_at: string;
  subject: { title: string; url: string | null; type: string };
  repository: { full_name: string; html_url: string };
}

// Keep runtime state out of git: the schedule dir + this `.gitignore` are
// versioned, but `state/` is not.
async function ensureGitignore(): Promise<void> {
  if (!existsSync(".gitignore")) await writeFile(".gitignore", "state/\n");
}

async function loadState(): Promise<State> {
  try {
    const s = JSON.parse(await Bun.file(STATE_FILE).text());
    if (typeof s.since === "string") {
      return { since: s.since, seen: Array.isArray(s.seen) ? s.seen : [] };
    }
  } catch {
    // First run or unreadable: start from "now" so we don't replay the backlog.
  }
  return { since: new Date().toISOString(), seen: [] };
}

async function saveState(state: State): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await Bun.write(STATE_FILE, JSON.stringify(state));
}

/** Run `assistant <args>` (argv, no shell) and parse its --json stdout. */
async function cli<T>(args: string[]): Promise<T> {
  const proc = Bun.spawn(["assistant", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `assistant ${args.slice(0, 2).join(" ")} exited ${code}: ${err.slice(0, 200)}`,
    );
  }
  return JSON.parse(out) as T;
}

async function fetchNotifications(since: string): Promise<GhNotification[]> {
  const all: GhNotification[] = [];
  for (let page = 1; ; page++) {
    const r = await cli<{ ok: boolean; status: number; body: unknown }>([
      "oauth", "request", "--provider", "github", "/notifications",
      "-G",
      "-d", "all=false",
      "-d", `since=${since}`,
      "-d", "per_page=50",
      "-d", `page=${page}`,
      "--json",
    ]);
    if (!r.ok || r.status >= 400) {
      throw new Error(`GitHub notifications API status ${r.status}`);
    }
    const items = Array.isArray(r.body) ? (r.body as GhNotification[]) : [];
    all.push(...items);
    if (items.length < 50) break; // last page
  }
  return all;
}

async function main(): Promise<void> {
  await ensureGitignore();
  const state = await loadState();
  const seen = new Set(state.seen);
  const fresh = (await fetchNotifications(state.since))
    .filter((n) => RELEVANT_REASONS.has(n.reason))
    .filter((n) => !seen.has(n.id));

  // Advance the cursor on every successful poll.
  const nextSince = new Date().toISOString();

  // No-op tick: nothing new → no conversation, no wake, no LLM call.
  if (fresh.length === 0) {
    await saveState({ since: nextSince, seen: state.seen });
    console.log(JSON.stringify({ ok: true, new: 0 }));
    return;
  }

  // Data-only digest — titles/repos/urls, no instructions. Fenced as untrusted.
  const digest = fresh.map((n) => ({
    id: n.id,
    reason: n.reason,
    type: n.subject.type,
    title: n.subject.title,
    repo: n.repository.full_name,
    url: n.subject.url ?? n.repository.html_url,
    updated: n.updated_at,
  }));

  // Fresh conversation per escalation (tagged `scheduled` via __SCHEDULE_RUN_ID).
  const conv = await cli<{ ok: boolean; id: string }>([
    "conversations", "new", "GitHub watcher", "--json",
  ]);

  // Wake it: trusted framing in --hint, untrusted payload fenced in
  // --external-content (implies --persist). Runs guardian + clientless.
  await cli<{ ok: boolean; invoked: boolean }>([
    "conversations", "wake", conv.id,
    "--source", "github-watcher",
    "--hint", ACTION_PROMPT,
    "--external-content", JSON.stringify(digest),
    "--persist",
    "--json",
  ]);

  const nextSeen = [...digest.map((d) => d.id), ...state.seen].slice(0, SEEN_CAP);
  await saveState({ since: nextSince, seen: nextSeen });
  console.log(
    JSON.stringify({ ok: true, new: fresh.length, conversationId: conv.id }),
  );
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
