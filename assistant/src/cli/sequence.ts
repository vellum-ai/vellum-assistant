/**
 * CLI command group: `vellum sequence`
 *
 * Manage email sequences — list, inspect, pause, resume, and view stats.
 */

import { Command } from 'commander';
import { initializeDb } from '../memory/db.js';
import {
  listSequences,
  getSequence,
  updateSequence,
  listEnrollments,
  exitEnrollment,
  countActiveEnrollments,
} from '../sequence/store.js';
import {
  getGuardrailConfig,
  setGuardrailConfig,
} from '../sequence/guardrails.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function output(data: unknown, json: boolean): void {
  process.stdout.write(
    json ? JSON.stringify(data) + '\n' : JSON.stringify(data, null, 2) + '\n',
  );
}

function exitError(message: string): void {
  output({ ok: false, error: message }, true);
  process.exitCode = 1;
}

function getJson(cmd: Command): boolean {
  let c: Command | null = cmd;
  while (c) {
    if ((c.opts() as { json?: boolean }).json) return true;
    c = c.parent;
  }
  return false;
}

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
// Command registration
// ---------------------------------------------------------------------------

export function registerSequenceCommand(program: Command): void {
  const seqCmd = program
    .command('sequence')
    .description('Manage email sequences')
    .option('--json', 'Machine-readable JSON output');

  // ── list ──────────────────────────────────────────────────────────
  seqCmd
    .command('list')
    .description('List all sequences')
    .option('--status <status>', 'Filter by status (active, paused, archived)')
    .action((opts: { status?: string }, cmd: Command) => {
      initializeDb();
      const json = getJson(cmd);
      const filter = opts.status ? { status: opts.status as 'active' | 'paused' | 'archived' } : undefined;
      const seqs = listSequences(filter);

      if (json) {
        output({ ok: true, sequences: seqs }, true);
        return;
      }

      if (seqs.length === 0) {
        process.stdout.write('No sequences found.\n');
        return;
      }

      process.stdout.write(`${seqs.length} sequence(s):\n\n`);
      for (const seq of seqs) {
        const active = countActiveEnrollments(seq.id);
        process.stdout.write(`  ${seq.name} (${seq.id}) — ${seq.status}, ${seq.steps.length} steps, ${active} active\n`);
      }
      process.stdout.write('\n');
    });

  // ── get ────────────────────────────────────────────────────────────
  seqCmd
    .command('get <id>')
    .description('Get sequence details with enrollment stats')
    .action((id: string, _opts: Record<string, unknown>, cmd: Command) => {
      initializeDb();
      const json = getJson(cmd);
      const seq = getSequence(id);
      if (!seq) return exitError(`Sequence not found: ${id}`);

      const enrollments = listEnrollments({ sequenceId: id });
      const statusCounts = enrollments.reduce((acc, e) => {
        acc[e.status] = (acc[e.status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      if (json) {
        output({ ok: true, sequence: seq, enrollments: { total: enrollments.length, byStatus: statusCounts } }, true);
        return;
      }

      const active = countActiveEnrollments(id);
      process.stdout.write(`  Name:          ${seq.name}\n`);
      process.stdout.write(`  ID:            ${seq.id}\n`);
      process.stdout.write(`  Status:        ${seq.status}\n`);
      process.stdout.write(`  Channel:       ${seq.channel}\n`);
      if (seq.description) process.stdout.write(`  Description:   ${seq.description}\n`);
      process.stdout.write(`  Exit on reply: ${seq.exitOnReply}\n`);
      process.stdout.write(`  Active:        ${active} enrollment(s)\n\n`);

      process.stdout.write(`  Steps (${seq.steps.length}):\n`);
      for (const step of seq.steps) {
        const delay = formatDuration(step.delaySeconds * 1000);
        const approval = step.requireApproval ? ' [approval required]' : '';
        process.stdout.write(`    ${step.index + 1}. "${step.subjectTemplate}" — delay: ${delay}${approval}\n`);
      }

      process.stdout.write(`\n  Enrollments: ${enrollments.length} total\n`);
      for (const [status, count] of Object.entries(statusCounts)) {
        process.stdout.write(`    ${status}: ${count}\n`);
      }
      process.stdout.write('\n');
    });

  // ── pause ──────────────────────────────────────────────────────────
  seqCmd
    .command('pause <id>')
    .description('Pause a sequence')
    .action((id: string, _opts: Record<string, unknown>, cmd: Command) => {
      initializeDb();
      const json = getJson(cmd);
      const seq = getSequence(id);
      if (!seq) return exitError(`Sequence not found: ${id}`);
      if (seq.status === 'paused') {
        output({ ok: true, message: 'Sequence is already paused.' }, json);
        return;
      }
      updateSequence(id, { status: 'paused' });
      output({ ok: true, message: `Sequence "${seq.name}" paused.` }, json);
    });

  // ── resume ─────────────────────────────────────────────────────────
  seqCmd
    .command('resume <id>')
    .description('Resume a paused sequence')
    .action((id: string, _opts: Record<string, unknown>, cmd: Command) => {
      initializeDb();
      const json = getJson(cmd);
      const seq = getSequence(id);
      if (!seq) return exitError(`Sequence not found: ${id}`);
      if (seq.status === 'active') {
        output({ ok: true, message: 'Sequence is already active.' }, json);
        return;
      }
      updateSequence(id, { status: 'active' });
      output({ ok: true, message: `Sequence "${seq.name}" resumed.` }, json);
    });

  // ── cancel-enrollment ──────────────────────────────────────────────
  seqCmd
    .command('cancel-enrollment <enrollmentId>')
    .description('Cancel a specific enrollment')
    .action((enrollmentId: string, _opts: Record<string, unknown>, cmd: Command) => {
      initializeDb();
      const json = getJson(cmd);
      exitEnrollment(enrollmentId, 'cancelled');
      output({ ok: true, message: `Enrollment ${enrollmentId} cancelled.` }, json);
    });

  // ── stats ──────────────────────────────────────────────────────────
  seqCmd
    .command('stats')
    .description('Overall sequence stats')
    .action((_opts: Record<string, unknown>, cmd: Command) => {
      initializeDb();
      const json = getJson(cmd);
      const seqs = listSequences();
      const activeSeqs = seqs.filter((s) => s.status === 'active').length;
      const allEnrollments = listEnrollments();
      const activeEnrollments = allEnrollments.filter((e) => e.status === 'active').length;

      const stats = {
        totalSequences: seqs.length,
        activeSequences: activeSeqs,
        totalEnrollments: allEnrollments.length,
        activeEnrollments,
      };

      if (json) {
        output({ ok: true, ...stats }, true);
        return;
      }

      process.stdout.write(`Sequence Stats:\n`);
      process.stdout.write(`  Sequences:   ${stats.totalSequences} total, ${stats.activeSequences} active\n`);
      process.stdout.write(`  Enrollments: ${stats.totalEnrollments} total, ${stats.activeEnrollments} active\n\n`);
    });

  // ── guardrails ─────────────────────────────────────────────────────
  const guardrailsCmd = seqCmd
    .command('guardrails')
    .description('View or update guardrail settings');

  guardrailsCmd
    .command('show')
    .description('Show current guardrail configuration')
    .action((_opts: Record<string, unknown>, cmd: Command) => {
      const json = getJson(cmd);
      const cfg = getGuardrailConfig();
      if (json) {
        output({ ok: true, config: cfg }, true);
        return;
      }
      process.stdout.write('Guardrail Configuration:\n');
      process.stdout.write(`  Daily send cap:         ${cfg.dailySendCap}\n`);
      process.stdout.write(`  Hourly rate (per-seq):  ${cfg.perSequenceHourlyRate}\n`);
      process.stdout.write(`  Min step delay:         ${cfg.minimumStepDelaySec}s\n`);
      process.stdout.write(`  Max active enrollments: ${cfg.maxActiveEnrollments}\n`);
      process.stdout.write(`  Duplicate check:        ${cfg.duplicateEnrollmentCheck}\n`);
      process.stdout.write(`  Cooldown period:        ${formatDuration(cfg.cooldownPeriodMs)}\n\n`);
    });

  guardrailsCmd
    .command('set <key> <value>')
    .description('Update a guardrail setting')
    .action((key: string, value: string, _opts: Record<string, unknown>, cmd: Command) => {
      const json = getJson(cmd);
      const numVal = Number(value);
      const boolVal = value === 'true' ? true : value === 'false' ? false : undefined;

      const patch: Partial<ReturnType<typeof getGuardrailConfig>> = {};
      switch (key) {
        case 'dailySendCap':
        case 'daily_send_cap':
          patch.dailySendCap = numVal;
          break;
        case 'perSequenceHourlyRate':
        case 'hourly_rate':
          patch.perSequenceHourlyRate = numVal;
          break;
        case 'minimumStepDelaySec':
        case 'min_delay':
          patch.minimumStepDelaySec = numVal;
          break;
        case 'maxActiveEnrollments':
        case 'max_enrollments':
          patch.maxActiveEnrollments = numVal;
          break;
        case 'duplicateEnrollmentCheck':
        case 'duplicate_check':
          if (boolVal === undefined) return exitError('Value must be true or false');
          patch.duplicateEnrollmentCheck = boolVal;
          break;
        case 'cooldownPeriodMs':
        case 'cooldown_days': {
          const days = numVal;
          patch.cooldownPeriodMs = days * 24 * 60 * 60 * 1000;
          break;
        }
        default:
          return exitError(`Unknown guardrail key: ${key}`);
      }

      const updated = setGuardrailConfig(patch);
      output({ ok: true, message: `Updated ${key} = ${value}`, config: updated }, json);
    });
}
