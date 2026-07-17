/**
 * `assistant inference callsites` CLI namespace.
 *
 *   callsites list          — effective resolution for every call site
 *   callsites get <site>    — resolution detail + chain for one call site
 *
 * Read-only. Delegates to the daemon (`inference_callsites_*`), which computes
 * resolution via the shared `resolveCallSiteConfig` / `selectWinningProfile`
 * machinery. Output is deliberately compact and aligned — it is mostly read by
 * the assistant itself.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { subcommand } from "../lib/cli-command-help.js";
import { renderTable, writeCliError, writeLine } from "../lib/cli-output.js";

type Source = "override" | "active" | "call_site" | "default";

interface CallSiteSummary {
  callSite: string;
  profile: string | null;
  label: string | null;
  source: Source;
  provider: string;
  model: string;
  effort: string;
  maxTokens: number;
  maxInputTokens?: number;
}

interface CallSiteDetail {
  callSite: string;
  winner: { profile: string | null; label: string | null; source: Source };
  resolved: {
    provider: string;
    model: string;
    maxTokens: number;
    effort: string;
    temperature: number | null;
    maxInputTokens?: number;
  };
  resolutionChain: { requested: string; reason: string }[];
  shippedDefault: Record<string, unknown>;
  userPin: Record<string, unknown> | null;
  resolutionError?: { reason: string; message: string };
}

const SOURCE_LABEL: Record<Source, string> = {
  override: "override",
  active: "active",
  call_site: "pin",
  default: "default",
};

function formatCtxIn(tokens: number | undefined): string {
  if (tokens == null) {
    return "-";
  }
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}M`;
  }
  return tokens.toLocaleString();
}

export function attachCallsitesSubcommand(inference: Command): void {
  const callsites = subcommand(inference, "callsites");

  subcommand(callsites, "list").action(async (opts: { json?: boolean }) => {
    const ipcResult = await cliIpcCall<{ callSites: CallSiteSummary[] }>(
      "inference_callsites_list",
      {},
    );
    if (!ipcResult.ok) {
      writeCliError(ipcResult.error ?? "Unknown error", opts.json);
      return;
    }
    const rows = ipcResult.result!.callSites;
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, callSites: rows }) + "\n",
      );
      return;
    }
    renderTable(
      ["CALL SITE", "PROFILE", "SRC", "PROVIDER", "MODEL", "EFFORT", "CTX-IN"],
      rows.map((r) => [
        r.callSite,
        r.profile ?? "(anchor)",
        SOURCE_LABEL[r.source],
        r.provider,
        r.model,
        r.effort,
        formatCtxIn(r.maxInputTokens),
      ]),
    );
  });

  subcommand(callsites, "get").action(
    async (site: string, opts: { json?: boolean }) => {
      const ipcResult = await cliIpcCall<CallSiteDetail>(
        "inference_callsites_get",
        { pathParams: { site } },
      );
      if (!ipcResult.ok) {
        writeCliError(ipcResult.error ?? "Unknown error", opts.json);
        return;
      }
      const d = ipcResult.result!;
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, ...d }) + "\n");
        return;
      }
      writeLine(`call site: ${d.callSite}`);
      writeLine(
        `  winner: ${d.winner.profile ?? "(anchor)"} [${SOURCE_LABEL[d.winner.source]}]` +
          (d.winner.label ? ` "${d.winner.label}"` : ""),
      );
      writeLine(
        `  resolved: ${d.resolved.provider}/${d.resolved.model} effort=${d.resolved.effort} maxTokens=${d.resolved.maxTokens}` +
          (d.resolved.maxInputTokens != null
            ? ` ctxIn=${formatCtxIn(d.resolved.maxInputTokens)}`
            : ""),
      );
      if (d.resolutionChain.length > 0) {
        writeLine("  resolution chain (skipped rungs):");
        for (const step of d.resolutionChain) {
          writeLine(`    - ${step.requested}: ${step.reason}`);
        }
      }
      writeLine(`  shipped default: ${JSON.stringify(d.shippedDefault)}`);
      writeLine(
        `  user pin: ${d.userPin ? JSON.stringify(d.userPin) : "(none)"}`,
      );
      if (d.resolutionError) {
        writeLine(
          `  resolution error [${d.resolutionError.reason}]: ${d.resolutionError.message}`,
        );
      }
    },
  );
}
