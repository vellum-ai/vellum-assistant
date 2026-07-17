/** Declarative help for the `assistant sequence` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const sequenceHelp: CliCommandHelp = {
  name: "sequence",
  description: "Manage email sequences",
  options: [{ flags: "--json", description: "Machine-readable JSON output" }],
  helpText: `
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
  subcommands: [
    {
      name: "list",
      description: "List all sequences",
      options: [
        {
          flags: "--status <status>",
          description: "Filter by status (active, paused, archived)",
        },
      ],
      helpText: `
Lists all sequences with summary info: name, ID, status, step count,
and active enrollment count.

--status filters by sequence status. Valid values: active, paused, archived.
If omitted, returns all sequences regardless of status.

Examples:
  $ assistant sequence list
  $ assistant sequence list --status active
  $ assistant sequence list --status paused --json`,
    },
    {
      name: "get",
      args: "<id>",
      description: "Get sequence details with enrollment stats",
      helpText: `
Arguments:
  id   The sequence ID (e.g. seq_abc123). Run 'assistant sequence list' to find IDs.

Returns full sequence details: name, status, channel, description, exit-on-reply
setting, all steps with delay and approval configuration, and enrollment
breakdown by status (active, paused, completed, replied, cancelled, failed).

Examples:
  $ assistant sequence get seq_abc123
  $ assistant sequence get seq_abc123 --json`,
    },
    {
      name: "pause",
      args: "<id>",
      description: "Pause a sequence",
      helpText: `
Arguments:
  id   The sequence ID to pause (e.g. seq_abc123). Run 'assistant sequence list' to find IDs.

Pauses a sequence, halting all scheduled step deliveries. Existing active
enrollments remain in their current state but no new steps will be sent
until the sequence is resumed. No-op if the sequence is already paused.

Examples:
  $ assistant sequence pause seq_abc123
  $ assistant sequence pause seq_abc123 --json`,
    },
    {
      name: "resume",
      args: "<id>",
      description: "Resume a paused sequence",
      helpText: `
Arguments:
  id   The sequence ID to resume (e.g. seq_abc123). Run 'assistant sequence list' to find IDs.

Resumes a paused sequence, re-enabling scheduled step deliveries for all
active enrollments. No-op if the sequence is already active.

Examples:
  $ assistant sequence resume seq_abc123
  $ assistant sequence resume seq_abc123 --json`,
    },
    {
      name: "cancel-enrollment",
      args: "<enrollmentId>",
      description: "Cancel a specific enrollment",
      helpText: `
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
    },
    {
      name: "stats",
      description: "Overall sequence stats",
      helpText: `
Returns aggregate statistics across all sequences: total and active
sequence counts, total and active enrollment counts.

Examples:
  $ assistant sequence stats
  $ assistant sequence stats --json`,
    },
    {
      name: "guardrails",
      description: "View or update guardrail settings",
      helpText: `
Guardrails are sequence-specific safety limits that prevent excessive
sending and protect deliverability. They enforce daily send caps, per-sequence
hourly rate limits, minimum delays between steps, maximum concurrent active
enrollments, duplicate enrollment prevention, and cooldown periods.

Examples:
  $ assistant sequence guardrails show
  $ assistant sequence guardrails set dailySendCap 200
  $ assistant sequence guardrails set cooldown_days 7`,
      subcommands: [
        {
          name: "show",
          description: "Show current guardrail configuration",
          helpText: `
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
        },
        {
          name: "set",
          args: "<key> <value>",
          description: "Update a guardrail setting",
          helpText: `
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
        },
      ],
    },
  ],
};
