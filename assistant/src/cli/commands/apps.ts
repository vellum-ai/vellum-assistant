import type { Command } from "commander";

import {
  cliIpcCall,
  exitCodeFromIpcResult,
} from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { shouldOutputJson, writeError, writeOutput } from "../output.js";
import { appsHelp } from "./apps.help.js";

interface AppListEntry {
  name: string;
  source: string;
}

interface AppsRefreshResponse {
  ok: true;
  appId: string;
  name: string;
  compiled: boolean;
  compile_duration_ms: number;
  compile_errors?: Array<{
    text: string;
    location?: { file: string; line: number; column: number };
  }>;
  compile_warnings?: Array<{
    text: string;
    location?: { file: string; line: number; column: number };
  }>;
}

function refreshHint(appId: string): string {
  return `Run 'assistant apps refresh ${appId}' to compile.`;
}

function formatDiagnostic(diag: {
  text: string;
  location?: { file: string; line: number; column: number };
}): string {
  if (!diag.location) {
    return diag.text;
  }
  return `${diag.location.file}:${diag.location.line}: ${diag.text}`;
}

export function registerAppsCommand(program: Command): void {
  registerCommand(program, {
    name: appsHelp.name,
    transport: "local",
    description: appsHelp.description,
    build: (apps) => {
      applyCommandHelp(apps, appsHelp);

      subcommand(apps, "list").action(async (opts: { json?: boolean }) => {
        // Lazy-import the app store so the daemon module graph loads only when
        // this command runs (cli/no-daemon-internals).
        const { listAllApps } = await import("../../apps/app-store.js");

        const entries: AppListEntry[] = listAllApps()
          .map(({ name, sourcePath }) => ({ name, source: sourcePath }))
          .sort((a, b) => a.name.localeCompare(b.name));

        if (opts.json) {
          console.log(JSON.stringify({ ok: true, apps: entries }));
          return;
        }

        if (entries.length === 0) {
          log.info("No apps found.");
          return;
        }

        // Name and source lead; align the name into a column so the source
        // path (which also identifies the app's origin) stays scannable.
        const nameWidth = Math.max(4, ...entries.map((e) => e.name.length));
        log.info(`Apps (${entries.length}):\n`);
        log.info(`  ${"NAME".padEnd(nameWidth)}  SOURCE`);
        for (const e of entries) {
          log.info(`  ${e.name.padEnd(nameWidth)}  ${e.source}`);
        }
      });

      subcommand(apps, "inspect").action(
        async (appName: string, opts: { json?: boolean }, cmd: Command) => {
          const { resolveAppQuery, appNotFoundMessage, appAmbiguousMessage } =
            await import("../../apps/resolve-app.js");
          const { inspectAppSource } = await import(
            "../../apps/source-fingerprint.js"
          );

          const resolved = resolveAppQuery(appName);
          if (!resolved.ok) {
            const message =
              resolved.reason === "ambiguous"
                ? appAmbiguousMessage(resolved.query, resolved.matches)
                : appNotFoundMessage(resolved.query);
            writeError(cmd, message);
            process.exitCode = 1;
            return;
          }

          const { app } = resolved;
          const inspect = inspectAppSource(app.sourcePath);
          const origin =
            app.origin.kind === "plugin"
              ? { kind: "plugin" as const, plugin: app.origin.pluginName }
              : { kind: "workspace" as const };

          if (opts.json || shouldOutputJson(cmd)) {
            writeOutput(cmd, {
              ok: true,
              app: {
                id: app.id,
                name: app.name,
                source: app.sourcePath,
                origin,
              },
              compile: inspect,
            });
            return;
          }

          const originLabel =
            origin.kind === "plugin"
              ? `plugin ${origin.plugin}`
              : "workspace";
          log.info(`App: ${app.name} (${originLabel})`);
          log.info(`Id: ${app.id}`);
          log.info(`Source: ${app.sourcePath}`);

          if (inspect.status === "clean") {
            const when = inspect.compiledAt
              ? ` (compiled ${inspect.compiledAt})`
              : "";
            log.info(`Compile: up to date${when}`);
            return;
          }
          if (inspect.status === "never_compiled") {
            log.info("Compile: never compiled");
            log.info(refreshHint(app.id));
            return;
          }
          if (inspect.status === "unknown_baseline") {
            log.info(
              "Compile: compiled, but no source fingerprint is recorded.",
            );
            log.info(
              `Run 'assistant apps refresh ${app.id}' to record one and rebuild.`,
            );
            return;
          }

          const when = inspect.compiledAt
            ? ` (last compiled ${inspect.compiledAt})`
            : "";
          log.info(`Compile: source changed since last compile${when}`);
          if (inspect.modified.length > 0) {
            log.info("Modified:");
            for (const path of inspect.modified) {
              log.info(`  ${path}`);
            }
          }
          if (inspect.added.length > 0) {
            log.info("Added:");
            for (const path of inspect.added) {
              log.info(`  ${path}`);
            }
          }
          if (inspect.removed.length > 0) {
            log.info("Removed:");
            for (const path of inspect.removed) {
              log.info(`  ${path}`);
            }
          }
          log.info(refreshHint(app.id));
        },
      );

      subcommand(apps, "refresh").action(
        async (appName: string, opts: { json?: boolean }, cmd: Command) => {
          const { resolveAppQuery, appNotFoundMessage, appAmbiguousMessage } =
            await import("../../apps/resolve-app.js");

          const resolved = resolveAppQuery(appName);
          if (!resolved.ok) {
            const message =
              resolved.reason === "ambiguous"
                ? appAmbiguousMessage(resolved.query, resolved.matches)
                : appNotFoundMessage(resolved.query);
            writeError(cmd, message);
            process.exitCode = 1;
            return;
          }

          const result = await cliIpcCall<AppsRefreshResponse>("apps_refresh", {
            pathParams: { id: resolved.app.id },
          });

          if (!result.ok || !result.result) {
            writeError(cmd, result.error ?? "Refresh failed");
            process.exitCode = exitCodeFromIpcResult(result);
            return;
          }

          const payload = result.result;
          if (opts.json || shouldOutputJson(cmd)) {
            writeOutput(cmd, payload);
            if (!payload.compiled) {
              process.exitCode = 1;
            }
            return;
          }

          if (!payload.compiled) {
            log.error(
              `Compile failed for "${payload.name}" (${payload.compile_duration_ms}ms).`,
            );
            for (const diag of payload.compile_errors ?? []) {
              log.error(`  ${formatDiagnostic(diag)}`);
            }
            process.exitCode = 1;
            return;
          }

          log.info(
            `Compiled "${payload.name}" in ${payload.compile_duration_ms}ms.`,
          );
        },
      );
    },
  });
}
