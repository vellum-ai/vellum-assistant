/** Declarative help for the `assistant config` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const configHelp: CliCommandHelp = {
  name: "config",
  description: "Manage configuration",
  helpText: `
Configuration is managed by the assistant. The CLI sends every read/write
through the assistant so the in-memory cache, provider registry, and
file-watcher stay coherent with config.json.

Keys support dotted paths for nested values (e.g. calls.enabled,
twilio.accountSid). Values are auto-parsed as JSON (booleans, numbers,
objects) with fallback to plain string if parsing fails.

API keys are managed separately via secure storage. Use "assistant keys list"
and "assistant keys set <provider> <key>" to view and manage API keys.

Examples:
  $ assistant config list
  $ assistant config get llm.defaultProvider.provider
  $ assistant config schema services
  $ assistant config set llm.defaultProvider.provider anthropic
  $ assistant config set calls.enabled true`,
  subcommands: [
    {
      name: "set",
      args: "<key> <value>",
      description:
        "Set a config value (supports dotted paths like calls.enabled)",
      helpText: `
Arguments:
  key     Dotted path to the config key (e.g. llm.defaultProvider.provider,
          calls.enabled, twilio.accountSid). Intermediate objects are created
          automatically.
  value   The value to store. Parsed as JSON first (so "true" becomes boolean
          true, "42" becomes number 42). Falls back to plain string if JSON
          parsing fails.

The CLI sends the change to the assistant, which assigns the value at the
given path, invalidates caches, and reinitializes providers so the new
value takes effect immediately. Object subtrees replace (not merge), and
explicit null is preserved.

To manage API keys, use "assistant keys set <provider> <key>" instead.

Examples:
  $ assistant config set llm.defaultProvider.provider anthropic
  $ assistant config set calls.enabled true`,
    },
    {
      name: "get",
      args: "<key>",
      description: "Get a config value (supports dotted paths)",
      helpText: `
Arguments:
  key   Dotted path to the config key (e.g. llm.defaultProvider.provider,
        calls.enabled)

Fetches the full config from the assistant and prints the value at the
given key path. If the key is not set, prints "(not set)". Object
values are pretty-printed as indented JSON.

To view API keys, use "assistant keys list" instead.

Examples:
  $ assistant config get llm.defaultProvider.provider
  $ assistant config get calls.enabled`,
    },
    {
      name: "schema",
      args: "[path]",
      description: "Print the JSON Schema for the config (or a sub-path)",
      helpText: `
Arguments:
  path   Optional dotted path to a config key (e.g. calls, memory.segmentation)

Asks the assistant for the JSON Schema of the entire config object, or
the sub-schema at the given path. Useful for understanding available
fields, their types, defaults, and constraints.

Examples:
  $ assistant config schema
  $ assistant config schema calls
  $ assistant config schema memory.segmentation`,
    },
    {
      name: "list",
      description: "List all config values",
      options: [
        {
          flags: "--search <query>",
          description:
            "Filter config entries by case-insensitive substring match on key name",
        },
      ],
      helpText: `
Fetches the full raw configuration from the assistant and prints it as
pretty-printed JSON. If no configuration has been set, prints
"No configuration set".

The --search flag filters results by case-insensitive substring match against
flattened dotted key paths. For example, --search calls matches calls.enabled,
calls.recordingEnabled, and any other key containing "calls".

Examples:
  $ assistant config list
  $ assistant config list --search api
  $ assistant config list --search calls`,
    },
    {
      name: "validate-allowlist",
      description: "Validate regex patterns in secret-allowlist.json",
      helpText: `
Reads secret-allowlist.json from the workspace and checks each regex pattern
for syntax errors. Reports the index and error message for any invalid
patterns. Exits with code 1 if any patterns are invalid, or prints a success
message if all patterns are valid. If no secret-allowlist.json file exists,
reports that and exits normally.

Examples:
  $ assistant config validate-allowlist`,
    },
  ],
};
