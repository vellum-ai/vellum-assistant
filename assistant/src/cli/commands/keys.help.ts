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
      options: [
        {
          flags: "--generated",
          description:
            "Assert the key was machine-obtained (e.g. an API exchange result) and never entered via chat; bypasses the agent-shell inline-secret guard",
        },
      ],
      helpText: `
Arguments:
  provider   Provider name (e.g. anthropic, openai, gemini)
  key        The API key value to store

If a key already exists for the given provider, it is silently overwritten.

When run from an agent shell (bash tool or skill sandbox), an inline key is
refused unless --generated is passed: user-supplied keys must be entered by
the user themselves — via the Settings page under API Keys, or by running
this command in their own terminal — so they never transit the conversation.
Pass --generated only for keys the agent machine-obtained itself (e.g. an
API exchange result) — never for keys typed or pasted by the user.

Examples:
  $ assistant keys set anthropic sk-ant-abc123
  $ assistant keys set openai sk-proj-xyz789
  $ assistant keys set fireworks fw-abc123
  $ assistant keys set acme "$(fetch-rotated-key acme)" --generated`,
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
