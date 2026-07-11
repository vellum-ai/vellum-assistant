/** Declarative help for the `assistant cache` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const cacheHelp: CliCommandHelp = {
  name: "cache",
  description: "Interact with the assistant's in-memory key/value cache",
  helpText: `
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
  subcommands: [
    {
      name: "set",
      description: "Store a JSON value in the cache",
      options: [
        {
          flags: "--key <key>",
          description:
            "Cache key for idempotent upsert. Omit to auto-generate.",
        },
        {
          flags: "--ttl <duration>",
          description:
            "Time-to-live (minimum 1s). Units: ms, s, m, h (e.g. 1000ms, 30s, 5m, 2h). Defaults to 30m if omitted.",
        },
        {
          flags: "--value <json>",
          description:
            "JSON payload to store. Alternative to piping via stdin.",
        },
        {
          flags: "--file <path>",
          description:
            "Path to a file containing the JSON payload. Alternative to piping via stdin.",
        },
        {
          flags: "--json",
          description: "Output result as machine-readable JSON.",
        },
      ],
      helpText: `
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
    },
    {
      name: "get",
      args: "<key>",
      description: "Retrieve a cached value by key",
      options: [
        {
          flags: "--json",
          description: "Output result as machine-readable JSON.",
        },
      ],
      helpText: `
Arguments:
  key   The cache key to look up. Run 'assistant cache set' to store a
        value and receive its key.

Fetches the value associated with the given key. If the key does not
exist or has expired, reports not-found. In --json mode, a miss returns
{ "ok": true, "data": null }.

Examples:
  $ assistant cache get my-key
  $ assistant cache get my-key --json`,
    },
    {
      name: "delete",
      args: "<key>",
      description: "Remove a cached entry by key",
      options: [
        {
          flags: "--json",
          description: "Output result as machine-readable JSON.",
        },
      ],
      helpText: `
Arguments:
  key   The cache key to remove. Run 'assistant cache get <key>' to
        verify a key exists before deleting.

Removes the entry from the cache. Idempotent — exits 0 whether the key
existed or not, but reports whether an entry was actually removed.

Examples:
  $ assistant cache delete my-key
  $ assistant cache delete my-key --json`,
    },
  ],
};
