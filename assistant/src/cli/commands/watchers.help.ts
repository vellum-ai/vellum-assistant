/** Declarative help for the `assistant watchers` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const watchersHelp: CliCommandHelp = {
  name: "watchers",
  description: "Manage polling watchers that monitor external services",
  helpText: `
Watchers poll external services (Gmail, Google Calendar, GitHub, Linear,
Outlook) on a configurable interval and process detected events via an
action prompt sent to a background conversation. Each watcher targets a
single provider and is identified by a UUID returned at creation time.

Watchers can be paused/resumed with --enabled/--disabled on update, and
recent activity is available via the digest subcommand.

Examples:
  $ assistant watchers create --name "My Gmail" --provider gmail --action-prompt "Summarize new emails"
  $ assistant watchers list
  $ assistant watchers list --id <watcherId>
  $ assistant watchers digest --hours 8`,
  subcommands: [
    {
      name: "list",
      description: "List all watchers or show details for a specific watcher",
      options: [
        {
          flags: "--id <watcherId>",
          description:
            "Show details for a specific watcher — run 'assistant watchers list' to find IDs",
        },
        { flags: "--enabled-only", description: "Only show enabled watchers" },
        {
          flags: "--json",
          description: "Output result as machine-readable JSON",
        },
      ],
      helpText: `
Arguments:
  --id <watcherId>   UUID of the watcher to inspect. Omit to list all
                     watchers. Run 'assistant watchers list' to discover IDs.
  --enabled-only     Filter to only enabled watchers.

When --id is provided, returns detailed info including the watcher's
configuration and its most recent events. Without --id, returns a
summary table of all watchers.

Examples:
  $ assistant watchers list
  $ assistant watchers list --enabled-only
  $ assistant watchers list --id abc123-def4-5678-abcd-ef1234567890
  $ assistant watchers list --json`,
    },
    {
      name: "create",
      description: "Create a new watcher",
      options: [
        { flags: "--name <name>", description: "Watcher name", required: true },
        {
          flags: "--provider <provider>",
          description:
            "Provider ID (gmail, google-calendar, github, linear, outlook, outlook-calendar)",
          required: true,
        },
        {
          flags: "--action-prompt <prompt>",
          description: "Action prompt for the watcher",
          required: true,
        },
        {
          flags: "--poll-interval <ms>",
          description:
            "Poll interval in milliseconds (default: 60000, min: 15000)",
        },
        {
          flags: "--config <json>",
          description: "Provider-specific config as JSON string",
        },
        {
          flags: "--credential-service <service>",
          description: "Credential service override",
        },
        {
          flags: "--json",
          description: "Output result as machine-readable JSON",
        },
      ],
      helpText: `
Arguments:
  --name <name>                Human-readable label (e.g. "Work Gmail")
  --provider <provider>        Service to poll: gmail, google-calendar, github,
                               linear, outlook, outlook-calendar
  --action-prompt <prompt>     LLM instructions for processing detected events.
                               Sent with event data to a background conversation.
  --poll-interval <ms>         Milliseconds between polls. Default 60000 (1 min),
                               minimum 15000 (15 sec).
  --config <json>              Provider-specific settings as a JSON string.
  --credential-service <svc>   Override the default credential service for the
                               provider. Rarely needed.

The watcher starts polling immediately after creation. Each provider
requires appropriate OAuth credentials to be configured beforehand.

Examples:
  $ assistant watchers create --name "My Gmail" --provider gmail --action-prompt "Summarize new emails and notify me if anything is urgent"
  $ assistant watchers create --name "PR Reviews" --provider github --action-prompt "Notify me of new review requests" --poll-interval 30000
  $ assistant watchers create --name "Team Linear" --provider linear --action-prompt "Flag high-priority issues" --config '{"teamId":"TEAM-1"}'`,
    },
    {
      name: "update",
      args: "<watcherId>",
      description: "Update an existing watcher",
      options: [
        { flags: "--name <name>", description: "New watcher name" },
        {
          flags: "--action-prompt <prompt>",
          description: "New action prompt",
        },
        {
          flags: "--poll-interval <ms>",
          description: "New poll interval in milliseconds (min: 15000)",
        },
        { flags: "--enabled", description: "Enable the watcher" },
        { flags: "--disabled", description: "Disable the watcher" },
        {
          flags: "--config <json>",
          description: "New provider-specific config as JSON string",
        },
        {
          flags: "--json",
          description: "Output result as machine-readable JSON",
        },
      ],
      helpText: `
Arguments:
  watcherId              UUID of the watcher to update — run 'assistant
                         watchers list' to find IDs.

Only the fields you specify are changed; omitted fields keep their
current values. Use --enabled/--disabled to pause and resume polling
without deleting the watcher.

Examples:
  $ assistant watchers update abc123 --action-prompt "Flag urgent emails and ignore newsletters"
  $ assistant watchers update abc123 --disabled
  $ assistant watchers update abc123 --enabled --poll-interval 120000`,
    },
    {
      name: "delete",
      args: "<watcherId>",
      description: "Delete a watcher and all its event history",
      options: [
        {
          flags: "--json",
          description: "Output result as machine-readable JSON",
        },
      ],
      helpText: `
Arguments:
  watcherId   UUID of the watcher to delete — run 'assistant watchers list'
              to find IDs.

Permanently removes the watcher and all its stored event history. This
action is irreversible. Disable the watcher with 'assistant watchers
update <id> --disabled' if you want to pause it instead.

Examples:
  $ assistant watchers delete abc123-def4-5678-abcd-ef1234567890
  $ assistant watchers delete abc123 --json`,
    },
    {
      name: "digest",
      description: "Show recent watcher events grouped by watcher",
      options: [
        {
          flags: "--id <watcherId>",
          description:
            "Filter to a single watcher — run 'assistant watchers list' to find IDs",
        },
        {
          flags: "--hours <n>",
          description: "Hours to look back (default: 24)",
        },
        {
          flags: "--limit <n>",
          description: "Maximum events to return (default: 50)",
        },
        {
          flags: "--json",
          description: "Output result as machine-readable JSON",
        },
      ],
      helpText: `
Arguments:
  --id <watcherId>   UUID of a watcher to filter by. Omit to show events
                     from all watchers. Run 'assistant watchers list' to
                     discover IDs.
  --hours <n>        Lookback window in hours. Defaults to 24.
  --limit <n>        Maximum number of events returned. Defaults to 50.

Events are grouped by watcher and sorted by creation time (newest first).
Use this to review what your watchers have detected recently.

Examples:
  $ assistant watchers digest
  $ assistant watchers digest --hours 8
  $ assistant watchers digest --id abc123 --hours 4 --limit 10
  $ assistant watchers digest --json`,
    },
  ],
};
