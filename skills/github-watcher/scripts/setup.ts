/**
 * Installs the GitHub watcher as a script-mode schedule that runs this skill's
 * `poll.ts` in place (cwd = the schedule's own dir, so state lives in
 * `schedules/<id>/state/`). `$__SCHEDULE_ID` resolves at run time, so the saved
 * command is static.
 *   bun scripts/setup.ts [--cron "<expr>"]   # default: every 15 minutes
 */

if (!process.env.VELLUM_WORKSPACE_DIR) {
  console.error("VELLUM_WORKSPACE_DIR is not set — run inside the assistant.");
  process.exit(1);
}

const cronIdx = process.argv.indexOf("--cron");
const cron = cronIdx >= 0 ? process.argv[cronIdx + 1] : "*/15 * * * *";

const command =
  'cd "$VELLUM_WORKSPACE_DIR/schedules/$__SCHEDULE_ID" && ' +
  'bun "$VELLUM_WORKSPACE_DIR/skills/github-watcher/scripts/poll.ts"';

const proc = Bun.spawn(
  [
    "assistant", "schedules", "create", "GitHub watcher",
    "--mode", "script",
    "--script", command,
    "--expression", cron,
    "--description", "Polls GitHub notifications and escalates new activity",
    "--timeout-ms", "300000",
    "--json",
  ],
  { stdout: "pipe", stderr: "pipe" },
);
const [out, err, code] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);

if (code !== 0) {
  console.error(`schedules create failed (exit ${code}): ${err.trim()}`);
  process.exit(1);
}

let id: string | undefined;
try {
  id = JSON.parse(out)?.schedule?.id as string | undefined;
} catch {
  // Non-JSON stdout; fall back to a bare confirmation.
}
console.log(`GitHub watcher scheduled${id ? ` (id ${id})` : ""}, cron ${cron}.`);
if (id) {
  console.log(
    `To customize, copy scripts/poll.ts into schedules/${id}/ (see SKILL.md).`,
  );
}
