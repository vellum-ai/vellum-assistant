/**
 * CLI command group: `assistant sequence`
 *
 * Thin IPC wrapper — all logic lives in sequence-routes.ts.
 */

import type { Command } from "commander";

import { cliIpcCall, exitFromIpcResult } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { sequenceHelp } from "./sequence.help.js";

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
  steps: {
    index: number;
    subjectTemplate: string;
    delaySeconds: number;
    requireApproval?: boolean;
  }[];
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
    name: sequenceHelp.name,
    transport: "ipc",
    description: sequenceHelp.description,
    build: (seqCmd) => {
      applyCommandHelp(seqCmd, sequenceHelp);

      // ── list ──────────────────────────────────────────────────────
      subcommand(seqCmd, "list").action(async (opts: { status?: string }) => {
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
      subcommand(seqCmd, "get").action(async (id: string) => {
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
        if (seq.channel)
          process.stdout.write(`  Channel:       ${seq.channel}\n`);
        if (seq.description)
          process.stdout.write(`  Description:   ${seq.description}\n`);
        process.stdout.write(`  Exit on reply: ${seq.exitOnReply}\n`);
        process.stdout.write(
          `  Active:        ${seq.activeEnrollments} enrollment(s)\n\n`,
        );

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
      subcommand(seqCmd, "pause").action(async (id: string) => {
        const json = resolveJson(seqCmd);
        const r = await cliIpcCall<{ message: string }>("sequence_pause", {
          id,
        });
        if (!r.ok) return exitFromIpcResult(r);

        if (json) {
          console.log(JSON.stringify({ ok: true, message: r.result!.message }));
        } else {
          process.stdout.write(r.result!.message + "\n");
        }
      });

      // ── resume ─────────────────────────────────────────────────────
      subcommand(seqCmd, "resume").action(async (id: string) => {
        const json = resolveJson(seqCmd);
        const r = await cliIpcCall<{ message: string }>("sequence_resume", {
          id,
        });
        if (!r.ok) return exitFromIpcResult(r);

        if (json) {
          console.log(JSON.stringify({ ok: true, message: r.result!.message }));
        } else {
          process.stdout.write(r.result!.message + "\n");
        }
      });

      // ── cancel-enrollment ──────────────────────────────────────────
      subcommand(seqCmd, "cancel-enrollment").action(
        async (enrollmentId: string) => {
          const json = resolveJson(seqCmd);
          const r = await cliIpcCall<{ message: string }>(
            "sequence_cancel_enrollment",
            { enrollmentId },
          );
          if (!r.ok) return exitFromIpcResult(r);

          if (json) {
            console.log(
              JSON.stringify({ ok: true, message: r.result!.message }),
            );
          } else {
            process.stdout.write(r.result!.message + "\n");
          }
        },
      );

      // ── stats ──────────────────────────────────────────────────────
      subcommand(seqCmd, "stats").action(async () => {
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
      const guardrailsCmd = subcommand(seqCmd, "guardrails");

      subcommand(guardrailsCmd, "show").action(async () => {
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

      subcommand(guardrailsCmd, "set").action(
        async (key: string, value: string) => {
          const json = resolveJson(seqCmd);
          const r = await cliIpcCall<{
            message: string;
            config: GuardrailConfig;
          }>("sequence_guardrails_set", { key, value });
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
        },
      );
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
