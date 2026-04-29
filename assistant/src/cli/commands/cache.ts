/**
 * `assistant cache` CLI namespace.
 *
 * Subcommands: set, get, delete — thin wrappers over the daemon's
 * cache IPC routes (`cache/set`, `cache/get`, `cache/delete`).
 */

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import { log } from "../logger.js";
import { existsSync, readFileSync } from "./cache-fs.js";

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
 * into milliseconds. Returns `undefined` when the input is `undefined`.
 * Throws on empty/whitespace-only or malformed input so the CLI can
 * surface actionable errors.
 */
function parseTtl(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!raw.trim()) {
    throw new Error(
      `Invalid --ttl value "${raw}". Expected a number followed by a unit: ms, s, m, or h (e.g. "1000ms", "30s", "5m", "2h"). Minimum 1s.`,
    );
  }
  const match = TTL_PATTERN.exec(raw.trim());
  if (!match) {
    throw new Error(
      `Invalid --ttl value "${raw}". Expected a number followed by a unit: ms, s, m, or h (e.g. "1000ms", "30s", "5m", "2h"). Minimum 1s.`,
    );
  }
  const value = Number(match[1]);
  const unit = match[2] as keyof typeof TTL_MULTIPLIERS;
  const ms = Math.round(value * TTL_MULTIPLIERS[unit]);
  if (ms <= 0) {
    throw new Error(`--ttl must resolve to a positive duration, got ${ms}ms.`);
  }
  if (ms < 1000) {
    throw new Error(
      `--ttl must be at least 1s (got ${ms}ms). Sub-second TTLs are not ` +
        `supported because CLI round-trip overhead would cause entries to ` +
        `expire before they can be read.`,
    );
  }
  return ms;
}

// ── Payload helpers ──────────────────────────────────────────────────

/**
 * Parse and validate a raw JSON string, emitting a size warning to stderr
 * if it exceeds 1 MB.
 */
function parseJsonPayload(raw: string, source: string): unknown {
  if (!raw.trim()) {
    throw new Error(
      `Empty input from ${source}. Provide valid JSON.\n` +
        '  Example: assistant cache set --value \'{"key":"value"}\'',
    );
  }

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
      `Invalid JSON from ${source}. Provide a valid JSON value.\n` +
        '  Example: assistant cache set --value \'{"key":"value"}\'',
    );
  }
}

/**
 * Read JSON payload from stdin when piped. Throws when stdin is a TTY
 * (no piped input) or when the input is empty/invalid JSON, so the CLI
 * can surface actionable parse errors.
 */
function readPayloadFromStdin(): unknown {
  if (process.stdin.isTTY) {
    throw new Error(
      "No input provided. Pipe JSON into stdin, or use --value / --file.\n" +
        '  Example: echo \'{"key":"value"}\' | assistant cache set\n' +
        '  Example: assistant cache set --value \'{"key":"value"}\'',
    );
  }

  let raw: string;
  try {
    raw = readFileSync("/dev/stdin", "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read stdin: ${err instanceof Error ? err.message : String(err)}.\n` +
        "Use --value or --file as an alternative when stdin is unavailable.",
    );
  }

  return parseJsonPayload(raw, "stdin");
}

/**
 * Read JSON payload from a file path. Throws on missing file or invalid JSON.
 */
function readPayloadFromFile(filePath: string): unknown {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return parseJsonPayload(raw, `file "${filePath}"`);
}

/**
 * Resolve the JSON payload from whichever input method was specified.
 * Priority: --value > --file > stdin.
 * Throws if multiple explicit sources are provided (--value + --file).
 */
function resolvePayload(opts: { value?: string; file?: string }): unknown {
  if (opts.value !== undefined && opts.file !== undefined) {
    throw new Error(
      "Cannot use both --value and --file. Provide exactly one input source.",
    );
  }

  if (opts.value !== undefined) {
    return parseJsonPayload(opts.value, "--value");
  }

  if (opts.file !== undefined) {
    return readPayloadFromFile(opts.file);
  }

  return readPayloadFromStdin();
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
  $ assistant cache set --value '{"result": [1,2,3]}' --ttl 5m
  $ assistant cache set --file /tmp/data.json --key my-key --ttl 1h
  $ echo '{"result": [1,2,3]}' | assistant cache set --ttl 5m
  $ assistant cache get my-key
  $ assistant cache delete my-key`,
  );

  // ── set ───────────────────────────────────────────────────────────

  cache
    .command("set")
    .description("Store a JSON value in the cache")
    .option(
      "--key <key>",
      "Cache key for idempotent upsert. Omit to auto-generate.",
    )
    .option(
      "--ttl <duration>",
      "Time-to-live (minimum 1s). Units: ms, s, m, h (e.g. 1000ms, 30s, 5m, 2h). Defaults to 30m if omitted.",
    )
    .option(
      "--value <json>",
      "JSON payload to store. Alternative to piping via stdin.",
    )
    .option(
      "--file <path>",
      "Path to a file containing the JSON payload. Alternative to piping via stdin.",
    )
    .option("--json", "Output result as machine-readable JSON.")
    .addHelpText(
      "after",
      `
Stores a JSON payload in the cache and prints the assigned key. The payload
can be provided via --value, --file, or piped through stdin. If --key is
provided, the entry is upserted (created or replaced). If omitted, a new
unique key is generated.

Payloads exceeding 1 MB emit a warning to stderr but are still stored.

Input sources (mutually exclusive, checked in this order):
  --value <json>    Inline JSON string.
  --file <path>     Path to a JSON file.
  (stdin)           Piped input (fallback when neither flag is given).

Options:
  --key <key>       Cache key string. Omit to auto-generate a random hex key.
  --ttl <duration>  Expiry duration (minimum 1s). Units: ms, s, m, h.
                    Examples: 1000ms, 30s, 5m, 2h. Defaults to 30m if omitted.
  --json            Output as JSON: { "ok": true, "key": "..." }

Examples:
  $ assistant cache set --value '{"scores":[98,85,72]}' --ttl 5m
  $ assistant cache set --file /tmp/payload.json --key scores --ttl 10m
  $ echo '{"scores":[98,85,72]}' | assistant cache set
  $ echo '"simple string"' | assistant cache set --ttl 1h --json`,
    )
    .action(
      async (opts: {
        key?: string;
        ttl?: string;
        value?: string;
        file?: string;
        json?: boolean;
      }) => {
        let data: unknown;
        try {
          data = resolvePayload(opts);
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

        const result = await cliIpcCall<{ key: string }>("cache_set", {
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
            JSON.stringify({ ok: true, key: result.result!.key }) + "\n",
          );
        } else {
          log.info(`Cached with key: ${result.result!.key}`);
        }
      },
    );

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
      const result = await cliIpcCall<{ data: unknown } | null>("cache_get", {
        body: { key },
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
      const result = await cliIpcCall<{ deleted: boolean }>("cache_delete", {
        body: { key },
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
