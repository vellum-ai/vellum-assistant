/** Declarative help for the `assistant keys` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const keysHelp: CliCommandHelp = {
  name: "keys",
  description: "Manage API keys in secure storage",
  subcommands: [
    {
      name: "list",
      description: "List all stored API key names",
    },
    {
      name: "set",
      args: "<provider> <key>",
      description:
        "Store an API key (e.g. assistant keys set anthropic sk-ant-...)",
      helpText: `
Arguments:
  provider   Provider name (e.g. anthropic, openai, gemini)
  key        The API key value to store

If a key already exists for the given provider, it is silently overwritten.

Examples:
  $ assistant keys set anthropic sk-ant-abc123
  $ assistant keys set openai sk-proj-xyz789
  $ assistant keys set fireworks fw-abc123`,
    },
    {
      name: "delete",
      args: "<provider>",
      description: "Delete a stored API key",
      helpText: `
Arguments:
  provider   Provider name whose key should be removed from secure storage

Removes the API key for the given provider from secure local storage. If
no key exists for the provider, exits with an error.

Examples:
  $ assistant keys delete openai
  $ assistant keys delete anthropic`,
    },
  ],
};
