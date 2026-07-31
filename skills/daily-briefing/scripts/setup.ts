/**
 * daily-briefing setup script
 *
 * Creates or updates the daily briefing schedule using the
 * `assistant schedules` CLI. Run this once to configure your briefing time
 * and timezone. After setup, manage it conversationally.
 *
 * Usage (the assistant calls this via bash):
 *   bun scripts/setup.ts
 *   bun scripts/setup.ts --time 08:00 --timezone America/New_York
 *   bun scripts/setup.ts --disable
 *   bun scripts/setup.ts --status
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const BRIEFING_NAME = "Daily Briefing";

const BRIEFING_PROMPT = `You are composing the user's proactive daily briefing. Use the memory context injected above to surface what matters today.

Structure the briefing:

**Daily Briefing — [today's date, e.g. Monday June 2]**

**Action Items** — Unresolved tasks, pending decisions, or commitments due today. Skip if none.
**Progress** — Notable completions or milestones from the past 24 hours. Skip if none.
**On Your Radar** — Anything flagged as important, upcoming, or worth watching. Skip if none.
**Suggested Next Steps** — 2-3 concrete actions for today, ranked by impact.

Rules: max 3-5 bullets per section; omit empty sections; end with one encouraging sentence.

After composing, deliver via bash:
  assistant notifications send --title "Daily Briefing -- [date]" --message "[briefing text]" --source-event-name "briefing.daily"`;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    time: { type: "string", default: "09:00" },
    timezone: { type: "string" },
    disable: { type: "boolean", default: false },
    status: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(`
daily-briefing setup

Usage:
  bun scripts/setup.ts [options]

Options:
  --time <HH:MM>        Delivery time in 24-hour format (default: 09:00)
  --timezone <tz>       IANA timezone (default: auto-detected from workspace)
  --disable             Pause the briefing without deleting it
  --status              Show current briefing configuration
  -h, --help            Show this help

Examples:
  bun scripts/setup.ts --time 08:00 --timezone America/New_York
  bun scripts/setup.ts --disable
  bun scripts/setup.ts --status
`);
  process.exit(0);
}

function validateTime(time: string): boolean {
  if (!/^\d{1,2}:\d{2}$/.test(time)) return false;
  const [h, m] = time.split(":").map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function validateTimezone(tz: string): boolean {
  // Defense-in-depth: only accept real IANA timezone names. The exec layer
  // below already prevents shell injection, but rejecting bogus input early
  // gives a clear error instead of a confusing CLI failure.
  try {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf?.("timeZone");
    if (supported && supported.length > 0) {
      return supported.includes(tz);
    }
    // Fallback for runtimes without supportedValuesOf: let the Intl
    // constructor validate. It throws RangeError on unknown zones.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseCron(time: string): string {
  const [h, m] = time.split(":").map(Number);
  return `${m} ${h} * * *`;
}

// Run a command WITHOUT a shell. Arguments are passed as an array to
// execFileSync, so untrusted values (e.g. --timezone) can never be
// interpreted as shell syntax. Never reintroduce a string/shell form here.
function run(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, { encoding: "utf-8" }).trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const display = [file, ...args].join(" ");
    throw new Error(`Command failed: ${display}\n${msg}`);
  }
}

function findExistingSchedule(): { id: string; enabled: boolean } | null {
  try {
    const raw = run("assistant", ["schedules", "list", "--json"]);
    const list = JSON.parse(raw) as Array<{
      id: string;
      name: string;
      enabled: boolean;
    }>;
    const match = list.find((s) => s.name === BRIEFING_NAME);
    return match ? { id: match.id, enabled: match.enabled } : null;
  } catch {
    return null;
  }
}

// -- status -----------------------------------------------------------
if (values.status) {
  const existing = findExistingSchedule();
  if (!existing) {
    console.log(
      "No daily briefing is configured. Run without --status to create one.",
    );
  } else {
    const raw = run("assistant", ["schedules", "list", "--json"]);
    const list = JSON.parse(raw) as Array<Record<string, unknown>>;
    const job = list.find((s) => s.name === BRIEFING_NAME);
    console.log(JSON.stringify(job, null, 2));
  }
  process.exit(0);
}

// -- disable ----------------------------------------------------------
if (values.disable) {
  const existing = findExistingSchedule();
  if (!existing) {
    console.log("No daily briefing found -- nothing to disable.");
    process.exit(0);
  }
  if (!existing.enabled) {
    console.log("Daily briefing is already disabled.");
    process.exit(0);
  }
  run("assistant", ["schedules", "disable", existing.id]);
  console.log("Daily briefing disabled. Run without --disable to re-enable.");
  process.exit(0);
}

// -- enable / create --------------------------------------------------
if (!validateTime(values.time!)) {
  console.error(
    `Error: invalid time "${values.time}". Use HH:MM 24-hour format, e.g. "09:00".`,
  );
  process.exit(1);
}

if (values.timezone && !validateTimezone(values.timezone)) {
  console.error(
    `Error: invalid timezone "${values.timezone}". Use an IANA timezone name, e.g. "America/New_York".`,
  );
  process.exit(1);
}

const cron = parseCron(values.time!);
const tzArgs = values.timezone ? ["--timezone", values.timezone] : [];
const existing = findExistingSchedule();

if (existing) {
  run("assistant", [
    "schedules",
    "update",
    existing.id,
    "--expression",
    cron,
    ...tzArgs,
  ]);
  if (!existing.enabled) {
    run("assistant", ["schedules", "enable", existing.id]);
  }
  console.log(
    `Daily briefing updated and enabled. Delivery: ${values.time}${values.timezone ? ` (${values.timezone})` : ""}.`,
  );
} else {
  run("assistant", [
    "schedules",
    "create",
    BRIEFING_NAME,
    "--expression",
    cron,
    ...tzArgs,
    "--message",
    BRIEFING_PROMPT,
    "--reuse-conversation",
  ]);
  console.log(
    `Daily briefing created. Delivery: ${values.time}${values.timezone ? ` (${values.timezone})` : ""}. You will receive your first briefing at the next scheduled time.`,
  );
}
