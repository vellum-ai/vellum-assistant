/**
 * `assistant cache` CLI namespace.
 *
 * Subcommands: set, get, delete — thin wrappers over the daemon's
 * cache IPC routes (`cache/set`, `cache/get`, `cache/delete`).
 */

import { readFileSync } from "node:fs";

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { log } from "../logger.js";

// ── Constants ─────────────────────────────────────────────────────────

/** Warn (stderr) when a raw payload exceeds this byte count. */
const MAX_PAYLOAD_BYTES = 1_000_000; // 1 MB

// ── TTL parsing ───────────────────────────────────────────────────────

const TTL_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/;

const TTL_MULTIPLIERS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parse a human-friendly duration string (e.g. `"30s"`, `"5m"`, `"2h"`)
 * into milliseconds. Returns `undefined` when the input is falsy.
 * Throws on malformed input so the CLI can surface actionable errors.
 */
function parseTtl(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = TTL_PATTERN.exec(raw.trim());
  if (!match) {
    throw new Error(
      `Invalid --ttl value "${raw}". Expected a number followed by a unit: ms, s, m, or h (e.g. "30s", "5m", "2h").`,
    );
  }
  const value = Number(match[1]);
  const unit = match[2] as keyof typeof TTL_MULTIPLIERS;
  const ms = Math.round(value * TTL_MULTIPLIERS[unit]);
  if (ms <= 0) {
    throw new Error(`--ttl must resolve to a positive duration, got ${ms}ms.`);
  }
  return ms;
}

// ── Stdin helpers ─────────────────────────────────────────────────────

/**
 * Read JSON payload from stdin when piped. Throws when stdin is a TTY
 * (no piped input) or when the input is empty/invalid JSON, so the CLI
 * can surface actionable parse errors.
 */
function readPayloadFromStdin(): unknown {
  if (process.stdin.isTTY) {
    throw new Error(
      "No input provided. Pipe JSON into stdin.\n" +
        '  Example: echo \'{"key":"value"}\' | assistant cache set',
    );
  }

  let raw: string;
  try {
    raw = readFileSync("/dev/stdin", "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read stdin: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!raw.trim()) {
    throw new Error(
      "Empty input on stdin. Pipe valid JSON.\n" +
        '  Example: echo \'{"key":"value"}\' | assistant cache set',
    );
  }

  // Warn on large payloads (but do not fail).
  // Write directly to stderr so --json stdout output stays clean.
  const byteLength = Buffer.byteLength(raw, "utf-8");
  if (byteLength > MAX_PAYLOAD_BYTES) {
    const sizeMb = (byteLength / 1_000_000).toFixed(2);
    process.stderr.write(
      `Warning: payload size (${sizeMb} MB) exceeds 1 MB. Large payloads may impact cache performance.\n`,
    );
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      "Invalid JSON on stdin. Provide a valid JSON value.\n" +
        '  Example: echo \'{"key":"value"}\' | assistant cache set',
    );
  }
}

// ── Registration ──────────────────────────────────────────────────────

export function registerCacheCommand(program: Command): void {
  const cache = program
    .command("cache")
    .description("Interact with the assistant's in-memory key/value cache");

  cache.addHelpText(
    "after",
    `
The cache is a TTL-aware, LRU-evicting in-memory store managed by the
running assistant. Data is scoped to the assistant process lifetime and
is not persisted across restarts.

Keys are opaque strings. If no key is provided on set, the assistant
generates one and returns it. Values can be any JSON-serializable data.

Examples:
  $ echo '{"result": [1,2,3]}' | assistant cache set --ttl 5m
  $ echo '{"result": [1,2,3]}' | assistant cache set --key my-key --ttl 1h
  $ assistant cache get my-key
  $ assistant cache delete my-key`,
  );

  // ── set ───────────────────────────────────────────────────────────

  cache
    .command("set")
    .description("Store a JSON value in the cache (reads payload from stdin)")
    .option(
      "--key <key>",
      "Cache key for idempotent upsert. Omit to auto-generate.",
    )
    .option(
      "--ttl <duration>",
      "Time-to-live with unit: ms, s, m, or h (e.g. 30s, 5m, 2h). Defaults to 30m if omitted.",
    )
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Reads a JSON payload from stdin, stores it in the cache, and prints the
assigned key. If --key is provided, the entry is upserted (created or
replaced). If omitted, a new unique key is generated.

Payloads exceeding 1 MB emit a warning to stderr but are still stored.

Arguments:
  (none — payload is read from stdin)

Options:
  --key <key>       Cache key string. Omit to auto-generate a random hex key.
  --ttl <duration>  Expiry duration. Accepted units: ms, s, m, h.
                    Examples: 500ms, 30s, 5m, 2h. Defaults to 30m if omitted.
  --json            Output as JSON: { "ok": true, "key": "..." }

Examples:
  $ echo '{"scores":[98,85,72]}' | assistant cache set
  $ echo '{"scores":[98,85,72]}' | assistant cache set --key scores --ttl 10m
  $ echo '"simple string"' | assistant cache set --ttl 1h --json`,
    )
    .action(async (opts: { key?: string; ttl?: string; json?: boolean }) => {
      let data: unknown;
      try {
        data = readPayloadFromStdin();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
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

      let ttl_ms: number | undefined;
      try {
        ttl_ms = parseTtl(opts.ttl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
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

      const params: Record<string, unknown> = { data };
      if (ttl_ms !== undefined) params.ttl_ms = ttl_ms;
      if (opts.key) params.key = opts.key;

      const result = await cliIpcCall<{ key: string }>("cache/set", params);

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
          JSON.stringify({ ok: true, key: result.result!.key }) + "\n",
        );
      } else {
        log.info(`Cached with key: ${result.result!.key}`);
      }
    });

  // ── get ───────────────────────────────────────────────────────────

  cache
    .command("get <key>")
    .description("Retrieve a cached value by key")
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Arguments:
  key   The cache key to look up. Run 'assistant cache set' to store a
        value and receive its key.

Fetches the value associated with the given key. If the key does not
exist or has expired, reports not-found. In --json mode, a miss returns
{ "ok": true, "data": null }.

Examples:
  $ assistant cache get my-key
  $ assistant cache get my-key --json`,
    )
    .action(async (key: string, opts: { json?: boolean }) => {
      const result = await cliIpcCall<{ data: unknown } | null>("cache/get", {
        key,
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
          JSON.stringify({
            ok: true,
            data: result.result ? result.result.data : null,
          }) + "\n",
        );
      } else {
        if (result.result == null) {
          log.info(`No cache entry found for key "${key}".`);
        } else {
          log.info(JSON.stringify(result.result.data, null, 2));
        }
      }
    });

  // ── delete ────────────────────────────────────────────────────────

  cache
    .command("delete <key>")
    .description("Remove a cached entry by key")
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Arguments:
  key   The cache key to remove. Run 'assistant cache get <key>' to
        verify a key exists before deleting.

Removes the entry from the cache. Idempotent — exits 0 whether the key
existed or not, but reports whether an entry was actually removed.

Examples:
  $ assistant cache delete my-key
  $ assistant cache delete my-key --json`,
    )
    .action(async (key: string, opts: { json?: boolean }) => {
      const result = await cliIpcCall<{ deleted: boolean }>("cache/delete", {
        key,
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

      const deleted = result.result!.deleted;

      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, deleted }) + "\n");
      } else {
        if (deleted) {
          log.info(`Deleted cache entry "${key}".`);
        } else {
          log.info(`No cache entry "${key}" (nothing to delete).`);
        }
      }
    });
}
