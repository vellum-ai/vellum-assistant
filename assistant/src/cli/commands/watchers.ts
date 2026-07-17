/**
 * `assistant watchers` CLI namespace.
 *
 * Subcommands: list, create, update, delete, digest — thin wrappers
 * over the daemon's watcher IPC routes (`watcher/list`, `watcher/create`,
 * `watcher/update`, `watcher/delete`, `watcher/digest`).
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { watchersHelp } from "./watchers.help.js";

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
  registerCommand(program, {
    name: watchersHelp.name,
    transport: "ipc",
    description: watchersHelp.description,
    build: (watchers) => {
      applyCommandHelp(watchers, watchersHelp);

      // ── list ────────────────────────────────────────────────────────────

      subcommand(watchers, "list").action(
        async (opts: {
          id?: string;
          enabledOnly?: boolean;
          json?: boolean;
        }) => {
          const params: Record<string, unknown> = {};
          if (opts.id) params.watcher_id = opts.id;
          if (opts.enabledOnly) params.enabled_only = true;

          const result = await cliIpcCall<
            WatcherRecord[] | { watcher: WatcherRecord; events: WatcherEvent[] }
          >("watcher_list", { body: params });

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

      subcommand(watchers, "create").action(
        async (opts: {
          name: string;
          provider: string;
          actionPrompt: string;
          pollInterval?: string;
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
            params.poll_interval_ms = parseInt(opts.pollInterval);
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

          const result = await cliIpcCall<WatcherRecord>("watcher_create", {
            body: params,
          });

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

      subcommand(watchers, "update").action(
        async (
          watcherId: string,
          opts: {
            name?: string;
            actionPrompt?: string;
            pollInterval?: string;
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
            params.poll_interval_ms = parseInt(opts.pollInterval);
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

          const result = await cliIpcCall<WatcherRecord>("watcher_update", {
            body: params,
          });

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

      subcommand(watchers, "delete").action(
        async (watcherId: string, opts: { json?: boolean }) => {
          const result = await cliIpcCall<{ deleted: boolean; name: string }>(
            "watcher_delete",
            { body: { watcher_id: watcherId } },
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
        },
      );

      // ── digest ──────────────────────────────────────────────────────────

      subcommand(watchers, "digest").action(
        async (opts: {
          id?: string;
          hours?: string;
          limit?: string;
          json?: boolean;
        }) => {
          const params: Record<string, unknown> = {};
          if (opts.id) params.watcher_id = opts.id;
          if (opts.hours !== undefined) params.hours = parseInt(opts.hours);
          if (opts.limit !== undefined) params.limit = parseInt(opts.limit);

          const result = await cliIpcCall<{
            events: WatcherEvent[];
            watcherNames: Record<string, string>;
          }>("watcher_digest", { body: params });

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
    },
  });
}
