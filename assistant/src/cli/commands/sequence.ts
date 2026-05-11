/**
 * CLI command group: `assistant sequence`
 *
 * Thin IPC wrapper — all logic lives in sequence-routes.ts.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { registerCommand } from "../lib/register-command.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SequenceSummary {
  id: string;
  name: string;
  status: string;
  steps: { index: number; subjectTemplate: string; delaySeconds: number; requireApproval?: boolean }[];
  activeEnrollments: number;
  description?: string;
  channel?: string;
  exitOnReply?: boolean;
}

interface GuardrailConfig {
  dailySendCap: number;
  perSequenceHourlyRate: number;
  minimumStepDelaySec: number;
  maxActiveEnrollments: number;
  duplicateEnrollmentCheck: boolean;
  cooldownPeriodMs: number;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerSequenceCommand(program: Command): void {
  registerCommand(program, {
    name: "sequence",
    transport: "ipc",
    description: "Manage email sequences",
    build: (seqCmd) => {
      seqCmd.option("--json", "Machine-readable JSON output");

      seqCmd.addHelpText(
        "after",
        `
Email sequences are automated multi-step email campaigns. Each sequence
contains ordered steps with configurable delays, subject/body templates,
and optional approval gates. Contacts are enrolled into a sequence and
progress through steps on a schedule.

Lifecycle: active -> paused -> active (resume) or active -> archived.
Enrollments track individual contacts through the sequence with statuses:
active, paused, completed, replied, cancelled, failed.

Guardrails enforce rate limits, daily send caps, cooldown periods, and
duplicate enrollment checks to prevent abuse.

Examples:
  $ assistant sequence list --status active
  $ assistant sequence get seq_abc123
  $ assistant sequence pause seq_abc123
  $ assistant sequence stats`,
      );

      // ── list ──────────────────────────────────────────────────────
      seqCmd
        .command("list")
        .description("List all sequences")
        .option("--status <status>", "Filter by status (active, paused, archived)")
        .addHelpText(
          "after",
          `
Lists all sequences with summary info: name, ID, status, step count,
and active enrollment count.

--status filters by sequence status. Valid values: active, paused, archived.
If omitted, returns all sequences regardless of status.

Examples:
  $ assistant sequence list
  $ assistant sequence list --status active
  $ assistant sequence list --status paused --json`,
        )
        .action(async (opts: { status?: string }) => {
          const json = resolveJson(seqCmd);
          const params: Record<string, unknown> = {};
          if (opts.status) params.status = opts.status;

          const r = await cliIpcCall<{ sequences: SequenceSummary[] }>(
            "sequence_list",
            params,
          );
          if (!r.ok) return exitFromIpcResult(r);

          const seqs = r.result!.sequences;

          if (json) {
            console.log(JSON.stringify({ ok: true, sequences: seqs }));
            return;
          }

          if (seqs.length === 0) {
            process.stdout.write("No sequences found.\n");
            return;
          }

          process.stdout.write(`${seqs.length} sequence(s):\n\n`);
          for (const seq of seqs) {
            process.stdout.write(
              `  ${seq.name} (${seq.id}) — ${seq.status}, ${seq.steps.length} steps, ${seq.activeEnrollments} active\n`,
            );
          }
          process.stdout.write("\n");
        });

      // ── get ────────────────────────────────────────────────────────
      seqCmd
        .command("get <id>")
        .description("Get sequence details with enrollment stats")
        .addHelpText(
          "after",
          `
Arguments:
  id   The sequence ID (e.g. seq_abc123). Run 'assistant sequence list' to find IDs.

Returns full sequence details: name, status, channel, description, exit-on-reply
setting, all steps with delay and approval configuration, and enrollment
breakdown by status (active, paused, completed, replied, cancelled, failed).

Examples:
  $ assistant sequence get seq_abc123
  $ assistant sequence get seq_abc123 --json`,
        )
        .action(async (id: string) => {
          const json = resolveJson(seqCmd);
          const r = await cliIpcCall<{
            sequence: SequenceSummary;
            enrollments: { total: number; byStatus: Record<string, number> };
          }>("sequence_get", { id });
          if (!r.ok) return exitFromIpcResult(r);

          const { sequence: seq, enrollments } = r.result!;

          if (json) {
            console.log(JSON.stringify({ ok: true, sequence: seq, enrollments }));
            return;
          }

          process.stdout.write(`  Name:          ${seq.name}\n`);
          process.stdout.write(`  ID:            ${seq.id}\n`);
          process.stdout.write(`  Status:        ${seq.status}\n`);
          if (seq.channel) process.stdout.write(`  Channel:       ${seq.channel}\n`);
          if (seq.description)
            process.stdout.write(`  Description:   ${seq.description}\n`);
          process.stdout.write(`  Exit on reply: ${seq.exitOnReply}\n`);
          process.stdout.write(`  Active:        ${seq.activeEnrollments} enrollment(s)\n\n`);

          process.stdout.write(`  Steps (${seq.steps.length}):\n`);
          for (const step of seq.steps) {
            const delay = formatDuration(step.delaySeconds * 1000);
            const approval = step.requireApproval ? " [approval required]" : "";
            process.stdout.write(
              `    ${step.index + 1}. "${step.subjectTemplate}" — delay: ${delay}${approval}\n`,
            );
          }

          process.stdout.write(`\n  Enrollments: ${enrollments.total} total\n`);
          for (const [status, count] of Object.entries(enrollments.byStatus)) {
            process.stdout.write(`    ${status}: ${count}\n`);
          }
          process.stdout.write("\n");
        });

      // ── pause ──────────────────────────────────────────────────────
      seqCmd
        .command("pause <id>")
        .description("Pause a sequence")
        .addHelpText(
          "after",
          `
Arguments:
  id   The sequence ID to pause (e.g. seq_abc123). Run 'assistant sequence list' to find IDs.

Pauses a sequence, halting all scheduled step deliveries. Existing active
enrollments remain in their current state but no new steps will be sent
until the sequence is resumed. No-op if the sequence is already paused.

Examples:
  $ assistant sequence pause seq_abc123
  $ assistant sequence pause seq_abc123 --json`,
        )
        .action(async (id: string) => {
          const json = resolveJson(seqCmd);
          const r = await cliIpcCall<{ message: string }>("sequence_pause", { id });
          if (!r.ok) return exitFromIpcResult(r);

          if (json) {
            console.log(JSON.stringify({ ok: true, message: r.result!.message }));
          } else {
            process.stdout.write(r.result!.message + "\n");
          }
        });

      // ── resume ─────────────────────────────────────────────────────
      seqCmd
        .command("resume <id>")
        .description("Resume a paused sequence")
        .addHelpText(
          "after",
          `
Arguments:
  id   The sequence ID to resume (e.g. seq_abc123). Run 'assistant sequence list' to find IDs.

Resumes a paused sequence, re-enabling scheduled step deliveries for all
active enrollments. No-op if the sequence is already active.

Examples:
  $ assistant sequence resume seq_abc123
  $ assistant sequence resume seq_abc123 --json`,
        )
        .action(async (id: string) => {
          const json = resolveJson(seqCmd);
          const r = await cliIpcCall<{ message: string }>("sequence_resume", { id });
          if (!r.ok) return exitFromIpcResult(r);

          if (json) {
            console.log(JSON.stringify({ ok: true, message: r.result!.message }));
          } else {
            process.stdout.write(r.result!.message + "\n");
          }
        });

      // ── cancel-enrollment ──────────────────────────────────────────
      seqCmd
        .command("cancel-enrollment <enrollmentId>")
        .description("Cancel a specific enrollment")
        .addHelpText(
          "after",
          `
Arguments:
  enrollmentId   The enrollment ID to cancel (e.g. enr_xyz789). Run 'assistant sequence get <id>'
                 to see enrollment IDs for a sequence.

Immediately cancels a specific enrollment, stopping all future step
deliveries for that contact in this sequence. The enrollment status
changes to "cancelled". This does not affect the sequence itself or
other enrollments.

Examples:
  $ assistant sequence cancel-enrollment enr_xyz789
  $ assistant sequence cancel-enrollment enr_xyz789 --json`,
        )
        .action(async (enrollmentId: string) => {
          const json = resolveJson(seqCmd);
          const r = await cliIpcCall<{ message: string }>(
            "sequence_cancel_enrollment",
            { enrollmentId },
          );
          if (!r.ok) return exitFromIpcResult(r);

          if (json) {
            console.log(JSON.stringify({ ok: true, message: r.result!.message }));
          } else {
            process.stdout.write(r.result!.message + "\n");
          }
        });

      // ── stats ──────────────────────────────────────────────────────
      seqCmd
        .command("stats")
        .description("Overall sequence stats")
        .addHelpText(
          "after",
          `
Returns aggregate statistics across all sequences: total and active
sequence counts, total and active enrollment counts.

Examples:
  $ assistant sequence stats
  $ assistant sequence stats --json`,
        )
        .action(async () => {
          const json = resolveJson(seqCmd);
          const r = await cliIpcCall<{
            totalSequences: number;
            activeSequences: number;
            totalEnrollments: number;
            activeEnrollments: number;
          }>("sequence_stats");
          if (!r.ok) return exitFromIpcResult(r);

          const stats = r.result!;

          if (json) {
            console.log(JSON.stringify({ ok: true, ...stats }));
            return;
          }

          process.stdout.write(`Sequence Stats:\n`);
          process.stdout.write(
            `  Sequences:   ${stats.totalSequences} total, ${stats.activeSequences} active\n`,
          );
          process.stdout.write(
            `  Enrollments: ${stats.totalEnrollments} total, ${stats.activeEnrollments} active\n\n`,
          );
        });

      // ── guardrails ─────────────────────────────────────────────────
      const guardrailsCmd = seqCmd
        .command("guardrails")
        .description("View or update guardrail settings");

      guardrailsCmd.addHelpText(
        "after",
        `
Guardrails are sequence-specific safety limits that prevent excessive
sending and protect deliverability. They enforce daily send caps, per-sequence
hourly rate limits, minimum delays between steps, maximum concurrent active
enrollments, duplicate enrollment prevention, and cooldown periods.

Examples:
  $ assistant sequence guardrails show
  $ assistant sequence guardrails set dailySendCap 200
  $ assistant sequence guardrails set cooldown_days 7`,
      );

      guardrailsCmd
        .command("show")
        .description("Show current guardrail configuration")
        .addHelpText(
          "after",
          `
Displays the current guardrail configuration with all safety limits:

  Daily send cap          Max emails sent per day across all sequences
  Hourly rate (per-seq)   Max emails per hour within a single sequence
  Min step delay          Minimum seconds between consecutive step deliveries
  Max active enrollments  Max concurrent active enrollments per sequence
  Duplicate check         Whether duplicate enrollment in the same sequence is blocked
  Cooldown period         Time before a contact can be re-enrolled after completion

Examples:
  $ assistant sequence guardrails show
  $ assistant sequence guardrails show --json`,
        )
        .action(async () => {
          const json = resolveJson(seqCmd);
          const r = await cliIpcCall<{ config: GuardrailConfig }>(
            "sequence_guardrails_show",
          );
          if (!r.ok) return exitFromIpcResult(r);

          const cfg = r.result!.config;

          if (json) {
            console.log(JSON.stringify({ ok: true, config: cfg }));
            return;
          }

          process.stdout.write("Guardrail Configuration:\n");
          process.stdout.write(`  Daily send cap:         ${cfg.dailySendCap}\n`);
          process.stdout.write(
            `  Hourly rate (per-seq):  ${cfg.perSequenceHourlyRate}\n`,
          );
          process.stdout.write(
            `  Min step delay:         ${cfg.minimumStepDelaySec}s\n`,
          );
          process.stdout.write(
            `  Max active enrollments: ${cfg.maxActiveEnrollments}\n`,
          );
          process.stdout.write(
            `  Duplicate check:        ${cfg.duplicateEnrollmentCheck}\n`,
          );
          process.stdout.write(
            `  Cooldown period:        ${formatDuration(cfg.cooldownPeriodMs)}\n\n`,
          );
        });

      guardrailsCmd
        .command("set <key> <value>")
        .description("Update a guardrail setting")
        .addHelpText(
          "after",
          `
Arguments:
  key     The guardrail setting name (see valid keys below)
  value   The new value (numeric for limits/caps, true/false for booleans)

Valid keys:
  dailySendCap (or daily_send_cap)            Max emails sent per day across all sequences (numeric)
  perSequenceHourlyRate (or hourly_rate)       Max emails per hour per sequence (numeric)
  minimumStepDelaySec (or min_delay)           Minimum delay in seconds between sequence steps (numeric)
  maxActiveEnrollments (or max_enrollments)    Max concurrent active enrollments per sequence (numeric)
  duplicateEnrollmentCheck (or duplicate_check) Prevent enrolling a contact already active in same sequence (true/false)
  cooldownPeriodMs                             Cooldown period in milliseconds before re-enrolling a contact (numeric)
  cooldown_days                                Cooldown period in days (converted to ms internally) (numeric)

Examples:
  $ assistant sequence guardrails set dailySendCap 200
  $ assistant sequence guardrails set hourly_rate 50
  $ assistant sequence guardrails set duplicate_check true
  $ assistant sequence guardrails set cooldown_days 7`,
        )
        .action(async (key: string, value: string) => {
          const json = resolveJson(seqCmd);
          const r = await cliIpcCall<{ message: string; config: GuardrailConfig }>(
            "sequence_guardrails_set",
            { key, value },
          );
          if (!r.ok) return exitFromIpcResult(r);

          if (json) {
            console.log(
              JSON.stringify({
                ok: true,
                message: r.result!.message,
                config: r.result!.config,
              }),
            );
          } else {
            process.stdout.write(r.result!.message + "\n");
          }
        });
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveJson(cmd: Command): boolean {
  let c: Command | null = cmd;
  while (c) {
    if ((c.opts() as { json?: boolean }).json) return true;
    c = c.parent;
  }
  return false;
}
