/**
 * `assistant inference profiles` CLI namespace.
 *
 *   profiles list                 — effective profile catalog (managed + user)
 *   profiles get <name>           — a single effective profile
 *   profiles create <name> ...    — create a validated custom profile
 *   profiles update <name> ...    — partial update of a custom profile
 *   profiles delete <name>        — delete a custom profile (managed protected)
 *   profiles active [name]        — read or set the active (chat) profile
 *
 * All subcommands delegate to the daemon via IPC. Provider/model/connection
 * validation is enforced by the daemon (`inference_profiles_*` routes); the
 * CLI only shape-parses flags.
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { renderTable, writeCliError, writeLine } from "../lib/cli-output.js";

interface ProfileSummary {
  name: string;
  label: string | null;
  provider: string | null;
  model: string | null;
  status: "active" | "disabled";
  source: "managed" | "user";
  provider_connection?: string;
  availability: { status: string; message?: string } | null;
}

interface ProfileWriteResult {
  ok: true;
  name: string;
  entry: Record<string, unknown>;
  warnings: string[];
}

type WriteFlags = {
  provider?: string;
  model?: string;
  connection?: string;
  label?: string;
  effort?: string;
  maxTokens?: string;
  temperature?: string;
  thinking?: string;
  description?: string;
  allowUnlisted?: boolean;
  json?: boolean;
};

/**
 * Parse the shared write flags into an IPC body. Returns an error string when
 * a numeric/enum flag is malformed. Only keys the user supplied are included.
 */
function buildWriteBody(
  opts: WriteFlags,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const body: Record<string, unknown> = {};
  if (opts.provider !== undefined) {
    body.provider = opts.provider;
  }
  if (opts.model !== undefined) {
    body.model = opts.model;
  }
  if (opts.connection !== undefined) {
    body.connection = opts.connection;
  }
  if (opts.label !== undefined) {
    body.label = opts.label;
  }
  if (opts.effort !== undefined) {
    body.effort = opts.effort;
  }
  if (opts.description !== undefined) {
    body.description = opts.description;
  }
  if (opts.allowUnlisted) {
    body.allowUnlisted = true;
  }

  if (opts.maxTokens !== undefined) {
    if (!/^\d+$/.test(opts.maxTokens.trim())) {
      return { ok: false, error: "--max-tokens must be a positive integer." };
    }
    body.maxTokens = Number(opts.maxTokens.trim());
  }
  if (opts.temperature !== undefined) {
    const value = Number(opts.temperature.trim());
    if (!Number.isFinite(value)) {
      return { ok: false, error: "--temperature must be a number." };
    }
    body.temperature = value;
  }
  if (opts.thinking !== undefined) {
    const normalized = opts.thinking.trim().toLowerCase();
    if (normalized !== "on" && normalized !== "off") {
      return { ok: false, error: "--thinking must be 'on' or 'off'." };
    }
    body.thinking = normalized === "on";
  }

  return { ok: true, body };
}

function printWriteResult(
  verb: string,
  result: ProfileWriteResult,
  json?: boolean,
): void {
  if (json) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  for (const warning of result.warnings) {
    writeLine(`warning: ${warning}`);
  }
  writeLine(`profile ${result.name} ${verb}`);
  writeLine(
    `Verify it works: assistant inference send --profile ${result.name} "Reply with OK"`,
  );
}

function addWriteFlags(cmd: Command): Command {
  return cmd
    .option("--provider <p>", "LLM provider (e.g. anthropic, openai)")
    .option("--model <id>", "Model id (see 'assistant inference models list')")
    .option("--connection <name>", "Provider connection name to use")
    .option("--label <text>", "Human-readable label")
    .option(
      "--effort <tier>",
      "Reasoning effort (none|low|medium|high|xhigh|max)",
    )
    .option("--max-tokens <n>", "Max response tokens")
    .option("--temperature <x>", "Sampling temperature")
    .option("--thinking <on|off>", "Enable or disable thinking")
    .option("--description <text>", "Profile description")
    .option("--allow-unlisted", "Allow a model not in the catalog (warns)")
    .option("--json", "Output as machine-readable JSON");
}

export function attachProfilesSubcommand(inference: Command): void {
  const profiles = inference
    .command("profiles")
    .description("Manage inference profiles (named model configurations)");

  profiles.addHelpText(
    "after",
    `
Profiles are named model configurations. Managed defaults (balanced,
quality-optimized, cost-optimized) are read-only; create your own to
customize provider, model, and tuning.

Examples:
  $ assistant inference profiles list
  $ assistant inference profiles create my-fast --provider anthropic \\
      --model claude-haiku-4-5 --connection anthropic-personal --effort low
  $ assistant inference profiles update my-fast --effort high
  $ assistant inference profiles active my-fast
  $ assistant inference profiles delete my-fast`,
  );

  // ── list ────────────────────────────────────────────────────────────
  profiles
    .command("list")
    .description("List the effective profile catalog")
    .option("--json", "Output as machine-readable JSON")
    .action(async (opts: { json?: boolean }) => {
      const ipcResult = await cliIpcCall<{ profiles: ProfileSummary[] }>(
        "inference_profiles_list",
        {},
      );
      if (!ipcResult.ok) {
        writeCliError(ipcResult.error ?? "Unknown error", opts.json);
        return;
      }
      const rows = ipcResult.result!.profiles;
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, profiles: rows }) + "\n",
        );
        return;
      }
      if (rows.length === 0) {
        writeLine("No profiles found.");
        return;
      }
      renderTable(
        ["NAME", "LABEL", "PROVIDER", "MODEL", "STATUS", "SOURCE", "AVAIL"],
        rows.map((p) => [
          p.name,
          p.label ?? "-",
          p.provider ?? "-",
          p.model ?? "-",
          p.status,
          p.source,
          p.availability ? p.availability.status : "-",
        ]),
      );
    });

  // ── get ─────────────────────────────────────────────────────────────
  profiles
    .command("get <name>")
    .description("Show a single effective profile")
    .option("--json", "Output as machine-readable JSON")
    .action(async (name: string, opts: { json?: boolean }) => {
      const ipcResult = await cliIpcCall<{
        name: string;
        entry: Record<string, unknown>;
        availability: { status: string; message?: string } | null;
      }>("inference_profiles_get", { pathParams: { name } });
      if (!ipcResult.ok) {
        writeCliError(ipcResult.error ?? "Unknown error", opts.json);
        return;
      }
      const result = ipcResult.result!;
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
        return;
      }
      writeLine(`profile: ${result.name}`);
      for (const [key, value] of Object.entries(result.entry)) {
        writeLine(`  ${key}: ${JSON.stringify(value)}`);
      }
      if (result.availability) {
        writeLine(`  availability: ${result.availability.status}`);
        if (result.availability.message) {
          writeLine(`    ${result.availability.message}`);
        }
      }
    });

  // ── create ──────────────────────────────────────────────────────────
  addWriteFlags(
    profiles
      .command("create <name>")
      .description("Create a validated custom profile"),
  ).action(async (name: string, opts: WriteFlags) => {
    if (!opts.provider) {
      writeCliError("--provider is required.", opts.json);
      return;
    }
    if (!opts.model) {
      writeCliError("--model is required.", opts.json);
      return;
    }
    const built = buildWriteBody(opts);
    if (!built.ok) {
      writeCliError(built.error, opts.json);
      return;
    }
    const ipcResult = await cliIpcCall<ProfileWriteResult>(
      "inference_profiles_create",
      { body: { ...built.body, name } },
    );
    if (!ipcResult.ok) {
      writeCliError(ipcResult.error ?? "Unknown error", opts.json);
      return;
    }
    printWriteResult("created", ipcResult.result!, opts.json);
  });

  // ── update ──────────────────────────────────────────────────────────
  addWriteFlags(
    profiles
      .command("update <name>")
      .description("Partially update a custom profile"),
  ).action(async (name: string, opts: WriteFlags) => {
    const built = buildWriteBody(opts);
    if (!built.ok) {
      writeCliError(built.error, opts.json);
      return;
    }
    if (Object.keys(built.body).length === 0) {
      writeCliError(
        "Nothing to update — pass at least one field flag.",
        opts.json,
      );
      return;
    }
    const ipcResult = await cliIpcCall<ProfileWriteResult>(
      "inference_profiles_update",
      { pathParams: { name }, body: built.body },
    );
    if (!ipcResult.ok) {
      writeCliError(ipcResult.error ?? "Unknown error", opts.json);
      return;
    }
    printWriteResult("updated", ipcResult.result!, opts.json);
  });

  // ── delete ──────────────────────────────────────────────────────────
  profiles
    .command("delete <name>")
    .description("Delete a custom profile")
    .option("--json", "Output as machine-readable JSON")
    .action(async (name: string, opts: { json?: boolean }) => {
      const ipcResult = await cliIpcCall<{ ok: true; name: string }>(
        "inference_profiles_delete",
        { pathParams: { name } },
      );
      if (!ipcResult.ok) {
        writeCliError(ipcResult.error ?? "Unknown error", opts.json);
        return;
      }
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, name: ipcResult.result!.name }) + "\n",
        );
        return;
      }
      writeLine(`profile ${name} deleted`);
    });

  // ── active ──────────────────────────────────────────────────────────
  profiles
    .command("active [name]")
    .description("Read or set the active (chat) profile")
    .option("--json", "Output as machine-readable JSON")
    .addHelpText(
      "after",
      `
With no argument, prints the active profile. With a name, sets it — the
same deep-merge write the model picker performs.

Examples:
  $ assistant inference profiles active
  $ assistant inference profiles active balanced`,
    )
    .action(async (name: string | undefined, opts: { json?: boolean }) => {
      if (name === undefined) {
        const ipcResult = await cliIpcCall<{
          llm?: { activeProfile?: string };
        }>("config_get");
        if (!ipcResult.ok) {
          writeCliError(ipcResult.error ?? "Unknown error", opts.json);
          return;
        }
        const active = ipcResult.result!.llm?.activeProfile ?? null;
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, activeProfile: active }) + "\n",
          );
          return;
        }
        writeLine(
          active ? `active profile: ${active}` : "no active profile set",
        );
        return;
      }

      const ipcResult = await cliIpcCall<{ ok: true; activeProfile: string }>(
        "inference_profiles_set_active",
        { body: { name } },
      );
      if (!ipcResult.ok) {
        writeCliError(ipcResult.error ?? "Unknown error", opts.json);
        return;
      }
      const activeProfile = ipcResult.result!.activeProfile;
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ok: true, activeProfile }) + "\n",
        );
        return;
      }
      writeLine(`active profile set to ${activeProfile}`);
    });
}
