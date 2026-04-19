/**
 * `assistant watchers` CLI namespace.
 *
 * Subcommands: list, create, update, delete, digest — thin wrappers
 * over the daemon's watcher IPC routes (`watcher/list`, `watcher/create`,
 * `watcher/update`, `watcher/delete`, `watcher/digest`).
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { log } from "../logger.js";

// -- Types for IPC results ----------------------------------------------------

interface WatcherRecord {
  id: string;
  name: string;
  providerId: string;
  actionPrompt: string;
  credentialService: string | null;
  pollIntervalMs: number;
  enabled: boolean;
  configJson: string | null;
  createdAt: number;
  updatedAt: number;
}

interface WatcherEvent {
  id: string;
  watcherId: string;
  eventType: string;
  summary: string | null;
  createdAt: number;
}

// -- Registration -------------------------------------------------------------

export function registerWatchersCommand(program: Command): void {
  const watchers = program
    .command("watchers")
    .description("Manage polling watchers that monitor external services");

  watchers.addHelpText(
    "after",
    `
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
  );

  // ── list ────────────────────────────────────────────────────────────

  watchers
    .command("list")
    .description("List all watchers or show details for a specific watcher")
    .option(
      "--id <watcherId>",
      "Show details for a specific watcher — run 'assistant watchers list' to find IDs",
    )
    .option("--enabled-only", "Only show enabled watchers")
    .option("--json", "Output result as machine-readable JSON")
    .addHelpText(
      "after",
      `
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
    )
    .action(
      async (opts: { id?: string; enabledOnly?: boolean; json?: boolean }) => {
        const params: Record<string, unknown> = {};
        if (opts.id) params.watcher_id = opts.id;
        if (opts.enabledOnly) params.enabled_only = true;

        const result = await cliIpcCall<
          WatcherRecord[] | { watcher: WatcherRecord; events: WatcherEvent[] }
        >("watcher/list", params);

        if (!result.ok) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: result.error }) + "\n",
            );
          } else {
            log.error(`Error: ${result.error}`);
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, data: result.result }) + "\n",
          );
          return;
        }

        // When --id is provided, the result is a detail object
        if (opts.id) {
          const detail = result.result as {
            watcher: WatcherRecord;
            events: WatcherEvent[];
          };
          const w = detail.watcher;
          log.info(`Watcher: ${w.name} (${w.id})`);
          log.info(`  Provider:      ${w.providerId}`);
          log.info(`  Enabled:       ${w.enabled}`);
          log.info(`  Poll interval: ${w.pollIntervalMs}ms`);
          log.info(`  Action prompt: ${w.actionPrompt}`);
          if (w.configJson) {
            log.info(`  Config:        ${w.configJson}`);
          }
          if (detail.events.length > 0) {
            log.info(`  Recent events: ${detail.events.length}`);
            for (const e of detail.events) {
              log.info(
                `    [${new Date(e.createdAt).toISOString()}] ${e.eventType}: ${e.summary ?? "(no summary)"}`,
              );
            }
          }
          return;
        }

        // List mode: array of watchers
        const list = result.result as WatcherRecord[];
        if (list.length === 0) {
          log.info("No watchers found.");
          return;
        }

        for (const w of list) {
          const status = w.enabled ? "enabled" : "disabled";
          log.info(`  ${w.id}  ${w.name}  ${w.providerId}  ${status}`);
        }
      },
    );

  // ── create ──────────────────────────────────────────────────────────

  watchers
    .command("create")
    .description("Create a new watcher")
    .requiredOption("--name <name>", "Watcher name")
    .requiredOption(
      "--provider <provider>",
      "Provider ID (gmail, google-calendar, github, linear, outlook, outlook-calendar)",
    )
    .requiredOption("--action-prompt <prompt>", "Action prompt for the watcher")
    .option(
      "--poll-interval <ms>",
      "Poll interval in milliseconds (default: 60000, min: 15000)",
      parseInt,
    )
    .option("--config <json>", "Provider-specific config as JSON string")
    .option("--credential-service <service>", "Credential service override")
    .option("--json", "Output result as machine-readable JSON")
    .addHelpText(
      "after",
      `
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
    )
    .action(
      async (opts: {
        name: string;
        provider: string;
        actionPrompt: string;
        pollInterval?: number;
        config?: string;
        credentialService?: string;
        json?: boolean;
      }) => {
        const params: Record<string, unknown> = {
          name: opts.name,
          provider: opts.provider,
          action_prompt: opts.actionPrompt,
        };

        if (opts.pollInterval !== undefined) {
          params.poll_interval_ms = opts.pollInterval;
        }
        if (opts.config !== undefined) {
          try {
            params.config = JSON.parse(opts.config);
          } catch {
            const msg = `Invalid --config JSON: ${opts.config}`;
            if (opts.json) {
              process.stdout.write(
                JSON.stringify({ ok: false, error: msg }) + "\n",
              );
            } else {
              log.error(msg);
            }
            process.exitCode = 1;
            return;
          }
        }
        if (opts.credentialService) {
          params.credential_service = opts.credentialService;
        }

        const result = await cliIpcCall<WatcherRecord>(
          "watcher/create",
          params,
        );

        if (!result.ok) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: result.error }) + "\n",
            );
          } else {
            log.error(`Error: ${result.error}`);
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, data: result.result }) + "\n",
          );
        } else {
          const w = result.result!;
          log.info(`Created watcher: ${w.name} (${w.id})`);
        }
      },
    );

  // ── update ──────────────────────────────────────────────────────────

  watchers
    .command("update <watcherId>")
    .description("Update an existing watcher")
    .option("--name <name>", "New watcher name")
    .option("--action-prompt <prompt>", "New action prompt")
    .option(
      "--poll-interval <ms>",
      "New poll interval in milliseconds (min: 15000)",
      parseInt,
    )
    .option("--enabled", "Enable the watcher")
    .option("--disabled", "Disable the watcher")
    .option("--config <json>", "New provider-specific config as JSON string")
    .option("--json", "Output result as machine-readable JSON")
    .addHelpText(
      "after",
      `
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
    )
    .action(
      async (
        watcherId: string,
        opts: {
          name?: string;
          actionPrompt?: string;
          pollInterval?: number;
          enabled?: boolean;
          disabled?: boolean;
          config?: string;
          json?: boolean;
        },
      ) => {
        const params: Record<string, unknown> = {
          watcher_id: watcherId,
        };

        if (opts.name !== undefined) params.name = opts.name;
        if (opts.actionPrompt !== undefined)
          params.action_prompt = opts.actionPrompt;
        if (opts.pollInterval !== undefined)
          params.poll_interval_ms = opts.pollInterval;
        if (opts.enabled) params.enabled = true;
        if (opts.disabled) params.enabled = false;
        if (opts.config !== undefined) {
          try {
            params.config = JSON.parse(opts.config);
          } catch {
            const msg = `Invalid --config JSON: ${opts.config}`;
            if (opts.json) {
              process.stdout.write(
                JSON.stringify({ ok: false, error: msg }) + "\n",
              );
            } else {
              log.error(msg);
            }
            process.exitCode = 1;
            return;
          }
        }

        const result = await cliIpcCall<WatcherRecord>(
          "watcher/update",
          params,
        );

        if (!result.ok) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: result.error }) + "\n",
            );
          } else {
            log.error(`Error: ${result.error}`);
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, data: result.result }) + "\n",
          );
        } else {
          const w = result.result!;
          log.info(`Updated watcher: ${w.name} (${w.id})`);
        }
      },
    );

  // ── delete ──────────────────────────────────────────────────────────

  watchers
    .command("delete <watcherId>")
    .description("Delete a watcher and all its event history")
    .option("--json", "Output result as machine-readable JSON")
    .addHelpText(
      "after",
      `
Arguments:
  watcherId   UUID of the watcher to delete — run 'assistant watchers list'
              to find IDs.

Permanently removes the watcher and all its stored event history. This
action is irreversible. Disable the watcher with 'assistant watchers
update <id> --disabled' if you want to pause it instead.

Examples:
  $ assistant watchers delete abc123-def4-5678-abcd-ef1234567890
  $ assistant watchers delete abc123 --json`,
    )
    .action(async (watcherId: string, opts: { json?: boolean }) => {
      const result = await cliIpcCall<{ deleted: boolean; name: string }>(
        "watcher/delete",
        { watcher_id: watcherId },
      );

      if (!result.ok) {
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: false, error: result.error }) + "\n",
          );
        } else {
          log.error(`Error: ${result.error}`);
        }
        process.exitCode = 1;
        return;
      }

      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, data: result.result }) + "\n",
        );
      } else {
        log.info(`Deleted watcher: ${result.result!.name}`);
      }
    });

  // ── digest ──────────────────────────────────────────────────────────

  watchers
    .command("digest")
    .description("Show recent watcher events grouped by watcher")
    .option(
      "--id <watcherId>",
      "Filter to a single watcher — run 'assistant watchers list' to find IDs",
    )
    .option("--hours <n>", "Hours to look back (default: 24)", parseInt)
    .option("--limit <n>", "Maximum events to return (default: 50)", parseInt)
    .option("--json", "Output result as machine-readable JSON")
    .addHelpText(
      "after",
      `
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
    )
    .action(
      async (opts: {
        id?: string;
        hours?: number;
        limit?: number;
        json?: boolean;
      }) => {
        const params: Record<string, unknown> = {};
        if (opts.id) params.watcher_id = opts.id;
        if (opts.hours !== undefined) params.hours = opts.hours;
        if (opts.limit !== undefined) params.limit = opts.limit;

        const result = await cliIpcCall<{
          events: WatcherEvent[];
          watcherNames: Record<string, string>;
        }>("watcher/digest", params);

        if (!result.ok) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: result.error }) + "\n",
            );
          } else {
            log.error(`Error: ${result.error}`);
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, data: result.result }) + "\n",
          );
          return;
        }

        const { events, watcherNames } = result.result!;
        if (events.length === 0) {
          log.info("No events found.");
          return;
        }

        // Group events by watcher
        const grouped: Record<string, WatcherEvent[]> = {};
        for (const e of events) {
          if (!grouped[e.watcherId]) grouped[e.watcherId] = [];
          grouped[e.watcherId].push(e);
        }

        for (const [watcherId, watcherEvents] of Object.entries(grouped)) {
          const name = watcherNames[watcherId] ?? watcherId;
          log.info(`${name} (${watcherId}):`);
          for (const e of watcherEvents) {
            log.info(
              `  [${new Date(e.createdAt).toISOString()}] ${e.eventType}: ${e.summary ?? "(no summary)"}`,
            );
          }
        }
      },
    );
}
