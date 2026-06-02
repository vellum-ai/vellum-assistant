/**
 * daily-briefing setup script
 *
 * Creates or updates the daily briefing schedule. Run this once to configure
 * your briefing time and timezone. After setup, manage it conversationally.
 *
 * Usage:
 *   bun scripts/setup.ts
 *   bun scripts/setup.ts --time 08:00 --timezone America/New_York
 *   bun scripts/setup.ts --disable
 *   bun scripts/setup.ts --status
 */

import { parseArgs } from "node:util";

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
  --timezone <tz>       IANA timezone (default: auto-detected)
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

function buildAction(): string {
  if (values.disable) return "disable";
  if (values.status) return "status";
  return "enable";
}

function validateTime(time: string): boolean {
  return /^\d{1,2}:\d{2}$/.test(time) && (() => {
    const [h, m] = time.split(":").map(Number);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
  })();
}

const action = buildAction();

if (action === "enable" && !validateTime(values.time!)) {
  console.error(
    `Error: invalid time "${values.time}". Use HH:MM 24-hour format, e.g. "09:00".`,
  );
  process.exit(1);
}

// Build the tool call payload for daily_briefing_configure
const payload: Record<string, unknown> = { action };
if (action === "enable") {
  payload.time = values.time;
  if (values.timezone) payload.timezone = values.timezone;
}

// Emit instructions for the agent — this script is loaded by skill_execute
// which passes the output back as tool result text.
console.log(`
To configure your daily briefing, call:

  daily_briefing_configure(${JSON.stringify(payload, null, 2)})

${action === "enable"
  ? `This will create a recurring schedule that fires every day at ${values.time}${values.timezone ? ` (${values.timezone})` : ""}.`
  : action === "disable"
    ? "This will pause the briefing without deleting it."
    : "This will show the current briefing status."}
`);
