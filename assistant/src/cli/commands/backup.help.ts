/**
 * Declarative help for the `assistant backup` command.
 *
 * Plain data (no action handlers, imports only the help contract type) so the
 * memory capability indexer can read it without pulling in the daemon/IPC action
 * graph. The handlers live in `backup.ts`, which applies this via
 * `applyCommandHelp` and attaches them.
 */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const backupHelp: CliCommandHelp = {
  name: "backup",
  description: "Manage automated backup configuration and list snapshots",
  helpText: `
Backups capture a snapshot of the assistant workspace (config, conversations,
trust rules, hooks, the SQLite database) as a .vbundle file. Credentials are
NOT included — they live in the OS keychain / CES and users re-authenticate
integrations after a restore (via the gateway). The automated worker runs on a configurable
interval and writes to a local pool under ~/.vellum/backups/local/, optionally
mirroring each snapshot to one or more offsite destinations (iCloud Drive by
default).

Offsite destinations can be per-destination encrypted (AES-256-GCM) or
plaintext — plaintext only makes sense when the user owns physical access to
the medium (e.g. an external SSD).

Examples:
  $ assistant backup enable --interval 6 --retention 3
  $ assistant backup destinations add /Volumes/BackupSSD/vellum --plaintext
  $ assistant backup status
  $ assistant backup list`,
  subcommands: [
    {
      name: "enable",
      description: "Enable automated backups",
      options: [
        {
          flags: "--interval <hours>",
          description:
            "Hours between automated backups (1-168). Defaults to 6.",
        },
        {
          flags: "--retention <n>",
          description:
            "Snapshots to retain per destination (1-100). Defaults to 3.",
        },
        {
          flags: "--no-offsite",
          description:
            "Disable offsite backup (local only). Does not touch the destinations list.",
        },
      ],
      helpText: `
Sets backup.enabled = true in config.json. Optionally overrides intervalHours,
retention, and the offsite.enabled flag. Does NOT modify
backup.offsite.destinations — use 'assistant backup destinations add/remove' to
manage those.

Examples:
  $ assistant backup enable
  $ assistant backup enable --interval 12 --retention 14
  $ assistant backup enable --no-offsite`,
    },
    {
      name: "disable",
      description: "Disable automated backups",
      helpText: `
Sets backup.enabled = false in config.json. Existing snapshots are untouched;
only the automated worker stops creating new ones.

Examples:
  $ assistant backup disable`,
    },
    {
      name: "destinations",
      description: "Manage offsite backup destinations",
      helpText: `
Offsite destinations are absolute paths the backup worker writes a copy of
each snapshot to after the local write succeeds. The default destination is
the iCloud Drive VellumAssistant folder, and it is used implicitly until an
explicit destinations array is configured. The first 'destinations add' or
'destinations remove' materializes the iCloud default before applying the
change, so the default is never lost on an accidental "clear all".

Each destination has an 'encrypt' flag. When true (the default), snapshots
are written as .vbundle.enc (AES-256-GCM). When false, snapshots are copied
as plaintext .vbundle — only use this for media you control physically.

Examples:
  $ assistant backup destinations list
  $ assistant backup destinations add /Volumes/BackupSSD/vellum --plaintext
  $ assistant backup destinations remove /Volumes/BackupSSD/vellum
  $ assistant backup destinations set-encrypt /Volumes/BackupSSD/vellum false`,
      subcommands: [
        {
          name: "list",
          description: "List configured offsite destinations",
          helpText: `
Resolves the current destinations array (materializing the iCloud default if
no explicit array is configured) and prints a table with the path and
encryption flag per row.

Examples:
  $ assistant backup destinations list`,
        },
        {
          name: "add",
          args: "<path>",
          description: "Add an offsite backup destination",
          options: [
            {
              flags: "--plaintext",
              description:
                "Write snapshots as plaintext .vbundle (default is AES-256-GCM encrypted .vbundle.enc)",
            },
          ],
          helpText: `
Arguments:
  path   Absolute path to the destination directory. Must be on a mount the
         caller controls; the backup worker writes files inside this
         directory, not the directory itself.

If backup.offsite.destinations is currently null (the implicit iCloud default),
the iCloud default is materialized first so the new entry appends to a
2-element array rather than replacing the default.

Examples:
  $ assistant backup destinations add /Volumes/BackupSSD/vellum --plaintext
  $ assistant backup destinations add ~/Dropbox/VellumAssistant/backups`,
        },
        {
          name: "remove",
          args: "<path>",
          description: "Remove an offsite backup destination by path",
          helpText: `
Arguments:
  path   Exact path match of the destination to remove. Run
         'assistant backup destinations list' to see configured paths.

Errors if no destination with the given path exists.

Examples:
  $ assistant backup destinations remove /Volumes/BackupSSD/vellum`,
        },
        {
          name: "set-encrypt",
          args: "<path> <value>",
          description: "Toggle encryption for an existing destination",
          helpText: `
Arguments:
  path    Exact path match of an existing destination. Run
          'assistant backup destinations list' to see configured paths.
  value   "true" to encrypt, "false" for plaintext writes.

Errors if no destination with the given path exists. Existing snapshot files
are not modified; only future writes honour the new setting.

Examples:
  $ assistant backup destinations set-encrypt /Volumes/BackupSSD/vellum false
  $ assistant backup destinations set-encrypt /Volumes/BackupSSD/vellum true`,
        },
      ],
    },
    {
      name: "status",
      description: "Show backup status and next-run timing",
      helpText: `
Reports enabled/disabled state, interval and retention, last-run and next-run
timing (from the backup:last_run_at memory checkpoint), and a per-destination
reachability probe. Unreachable destinations (parent directory missing, e.g.
iCloud Drive not enabled or external volume unplugged) are flagged
[unreachable] and skipped by the worker.

Examples:
  $ assistant backup status`,
    },
    {
      name: "list",
      description: "List all backup snapshots, grouped by destination",
      helpText: `
Prints a per-destination table of snapshots with timestamp, size, and
encryption flag. Local destination is listed first, followed by each offsite
destination. Unreachable destinations are listed with an empty snapshot set.

Examples:
  $ assistant backup list`,
    },
  ],
};
