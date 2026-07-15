/** Declarative help for the `assistant inference` command. */

import type {
  CliCommandHelp,
  CliOptionHelp,
  CliSubcommandHelp,
} from "../lib/cli-command-help.js";

/**
 * Shared write flags for `profiles create` / `profiles update` (mirrors the
 * former `addWriteFlags` helper so both subcommands stay in sync).
 */
const profileWriteOptions: CliOptionHelp[] = [
  {
    flags: "--provider <p>",
    description: "LLM provider (e.g. anthropic, openai)",
  },
  {
    flags: "--model <id>",
    description: "Model id (see 'assistant inference models list')",
  },
  {
    flags: "--connection <name>",
    description: "Provider connection name to use",
  },
  { flags: "--label <text>", description: "Human-readable label" },
  {
    flags: "--effort <tier>",
    description: "Reasoning effort (none|low|medium|high|xhigh|max)",
  },
  { flags: "--max-tokens <n>", description: "Max response tokens" },
  { flags: "--temperature <x>", description: "Sampling temperature" },
  { flags: "--thinking <on|off>", description: "Enable or disable thinking" },
  { flags: "--description <text>", description: "Profile description" },
  {
    flags: "--allow-unlisted",
    description: "Allow a model not in the catalog (warns)",
  },
  { flags: "--json", description: "Output as machine-readable JSON" },
];

/** `send` is shared verbatim between `inference` and its `llm` alias. */
const sendSubcommandHelp: CliSubcommandHelp = {
  name: "send",
  description: "Send a message to the configured LLM and print the response",
  arguments: [
    { name: "[message...]", description: "User message (joined with spaces)" },
  ],
  options: [
    {
      flags: "--system-prompt <text>",
      description: "System prompt for the model",
    },
    { flags: "--model <model-id>", description: "Model override" },
    {
      flags: "--profile <name>",
      description:
        "Apply a named inference profile from llm.profiles for this single call",
    },
    { flags: "--max-tokens <n>", description: "Max response tokens" },
    {
      flags: "--timeout-seconds <seconds>",
      description: "Maximum time to wait for the inference response",
    },
    { flags: "--json", description: "Output structured JSON" },
  ],
  helpText: `
Behavioral notes:
  - If no message argument is provided, reads from stdin.
  - If --model is omitted, uses the configured default model.
  - --profile applies a named profile from llm.profiles for this single call
    only. It does NOT open a session — to pin a profile to a conversation,
    use 'assistant inference profile open <name>'.
  - --profile layers below --model: --model still wins on the model field.
  - Long-running requests wait up to 32 minutes by default. Use
    --timeout-seconds to adjust the wait budget for this call.
  - Requires a configured LLM provider (see 'assistant config set').

Examples:
  $ assistant inference send "What is 2+2?"
  $ echo "Summarize this" | assistant inference send
  $ assistant llm send --system-prompt "You are a poet" "Write a haiku"
  $ assistant inference send --timeout-seconds 300 "Draft a long memo"
  $ assistant inference send --model claude-sonnet-4-20250514 --json "Hello"
  $ assistant inference send --profile balanced "Explain RFC 1149"`,
};

export const inferenceHelp: CliCommandHelp = {
  name: "inference",
  description: "LLM inference operations",
  helpText: `
The inference command group sends requests to your configured LLM provider.
The provider is resolved from your assistant config (llm.defaultProvider).

Examples:
  $ assistant inference send "What is the capital of France?"
  $ echo "Explain quantum computing" | assistant inference send
  $ assistant llm send --system-prompt "Be concise" "What is TCP?"
  $ assistant inference send --model claude-sonnet-4-20250514 --json "Hello"
  $ assistant inference send --profile balanced "Explain RFC 1149"`,
  subcommands: [
    sendSubcommandHelp,
    {
      name: "session",
      description: "Manage conversation-scoped inference profile sessions",
      helpText: `
Inference profile sessions pin a named model profile to a specific
conversation for the duration of the session.

Examples:
  $ assistant inference session open balanced --ttl 30m
  $ assistant inference session open fast --ttl never
  $ assistant inference session close
  $ assistant inference session list`,
      subcommands: [
        {
          name: "open",
          args: "<profileName>",
          description: "Open a profile session for the current conversation",
          options: [
            {
              flags: "--ttl <duration>",
              description:
                'Session TTL (e.g. 30m, 1h, "never" for sticky; default: 30m)',
            },
            {
              flags: "--conversation-id <id>",
              description:
                "Conversation ID (auto-resolved from context if omitted)",
            },
            {
              flags: "--json",
              description: "Output result as machine-readable JSON",
            },
          ],
          helpText: `
Opens a profile session that pins the given profile to the current
conversation. The session expires after --ttl, or is sticky (no
expiry) if --ttl never is specified. If --ttl is omitted, the session
defaults to 30m.

Examples:
  $ assistant inference session open balanced --ttl 30m
  $ assistant inference session open fast --ttl never
  $ assistant inference session open balanced            # uses default 30m TTL
  $ assistant inference session open balanced --json`,
        },
        {
          name: "close",
          description:
            "Close the active profile session for the current conversation",
          options: [
            {
              flags: "--conversation-id <id>",
              description:
                "Conversation ID (auto-resolved from context if omitted)",
            },
            {
              flags: "--json",
              description: "Output result as machine-readable JSON",
            },
          ],
          helpText: `
Closes the active profile session for the conversation. This is
idempotent — if no session is active the command succeeds with
a "no active profile session" message.

Examples:
  $ assistant inference session close
  $ assistant inference session close --json`,
        },
        {
          name: "list",
          description: "List active profile sessions",
          options: [
            {
              flags: "--conversation-id <id>",
              description: "Filter to a specific conversation ID",
            },
            {
              flags: "--json",
              description: "Output result as machine-readable JSON",
            },
          ],
          helpText: `
Lists all active inference profile sessions. Optionally filter by
conversation ID.

Examples:
  $ assistant inference session list
  $ assistant inference session list --conversation-id conv-abc123
  $ assistant inference session list --json`,
        },
      ],
    },
    {
      name: "providers",
      description: "Manage the model providers this assistant can use",
      helpText: `
A provider entry names a model provider plus how to reach it. Auth is
derived from the provider: keyless providers (ollama) need none, the
Vellum entry routes through the platform's managed proxy, and everything
else uses an API key referenced by --credential.

Canonical entry (seeded on every boot):
  vellum → the platform-managed provider; cannot be deleted

Examples:
  $ assistant inference providers list
  $ assistant inference providers get vellum
  $ assistant inference providers create anthropic-personal \\
      --provider anthropic --credential credential/anthropic/api_key
  $ assistant inference providers create local-llm \\
      --provider openai-compatible \\
      --base-url http://localhost:1234/v1 --model my-model
  $ assistant inference providers update anthropic-personal \\
      --credential credential/anthropic/api_key
  $ assistant inference providers delete anthropic-personal

After creating or updating a provider, validate it with a live call through
a profile that uses it:
  $ assistant inference send --profile <profile> "Reply with OK"`,
      subcommands: [
        {
          name: "list",
          description: "List configured providers",
          options: [
            { flags: "--provider <p>", description: "Filter by provider" },
            { flags: "--json", description: "Output as JSON" },
          ],
        },
        {
          name: "get",
          args: "<name>",
          description: "Show a single provider entry",
          options: [{ flags: "--json", description: "Output as JSON" }],
        },
        {
          // NOTE: the repeatable `--model` collector option and the
          // trailing `--json` are registered imperatively in
          // `inference-providers.ts` (array-accumulating parser functions
          // are not expressible as plain help data).
          name: "create",
          args: "<name>",
          description: "Add a provider",
          options: [
            {
              flags: "--provider <p>",
              description: "Provider (anthropic|openai|gemini|ollama|...)",
              required: true,
            },
            {
              flags: "--credential <vault-key>",
              description:
                "Vault credential name (required for API-key providers)",
            },
            {
              flags: "--auth <type>",
              description:
                "Override the derived auth: api_key|platform|none|oauth_subscription",
            },
            {
              flags: "--base-url <url>",
              description:
                "Endpoint base URL (required for --provider openai-compatible)",
            },
          ],
        },
        {
          // NOTE: `--model` + `--json` registered imperatively — see `create`.
          name: "update",
          args: "<name>",
          description: "Update a provider entry",
          options: [
            {
              flags: "--credential <vault-key>",
              description:
                "Rotate the API-key credential (derives api_key auth)",
            },
            {
              flags: "--auth <type>",
              description:
                "Override the auth explicitly: api_key|platform|none|oauth_subscription",
            },
            {
              flags: "--base-url <url>",
              description: "Endpoint base URL (openai-compatible providers)",
            },
          ],
        },
        {
          name: "delete",
          args: "<name>",
          description: "Remove a provider",
          options: [{ flags: "--json", description: "Output as JSON" }],
        },
        {
          name: "connections",
          description:
            "(Deprecated) use `assistant inference providers <verb>` instead",
          helpText: `
Deprecated alias kept for one release: every verb here is the same as the
matching \`assistant inference providers <verb>\` command.`,
          subcommands: [
            {
              name: "list",
              description: "(Deprecated) use `providers list`",
              options: [
                { flags: "--provider <p>", description: "Filter by provider" },
                { flags: "--json", description: "Output as JSON" },
              ],
            },
            {
              name: "get",
              args: "<name>",
              description: "(Deprecated) use `providers get`",
              options: [{ flags: "--json", description: "Output as JSON" }],
            },
            {
              name: "create",
              args: "<name>",
              description: "(Deprecated) use `providers create`",
              options: [
                {
                  flags: "--provider <p>",
                  description: "Provider (anthropic|openai|gemini|ollama|...)",
                  required: true,
                },
                {
                  flags: "--credential <vault-key>",
                  description:
                    "Vault credential name (required for API-key providers)",
                },
                {
                  flags: "--auth <type>",
                  description:
                    "Override the derived auth: api_key|platform|none|oauth_subscription",
                },
                {
                  flags: "--base-url <url>",
                  description:
                    "Endpoint base URL (required for --provider openai-compatible)",
                },
              ],
            },
            {
              name: "update",
              args: "<name>",
              description: "(Deprecated) use `providers update`",
              options: [
                {
                  flags: "--credential <vault-key>",
                  description:
                    "Rotate the API-key credential (derives api_key auth)",
                },
                {
                  flags: "--auth <type>",
                  description:
                    "Override the auth explicitly: api_key|platform|none|oauth_subscription",
                },
                {
                  flags: "--base-url <url>",
                  description:
                    "Endpoint base URL (openai-compatible providers)",
                },
              ],
            },
            {
              name: "delete",
              args: "<name>",
              description: "(Deprecated) use `providers delete`",
              options: [{ flags: "--json", description: "Output as JSON" }],
            },
          ],
        },
        {
          name: "login-chatgpt",
          description: "Authenticate with ChatGPT via browser OAuth flow",
          options: [{ flags: "--json", description: "Output as JSON" }],
        },
        {
          name: "default",
          args: "[name]",
          description: "Read or set the default provider (prints availability)",
          options: [
            {
              flags: "--connection <name>",
              description: "Pin a specific provider entry when setting",
            },
            {
              flags: "--json",
              description: "Output as machine-readable JSON",
            },
          ],
          helpText: `
With no argument, prints the default provider and whether it is usable.
With a provider name, sets it (optionally pinning a connection).

Examples:
  $ assistant inference providers default
  $ assistant inference providers default anthropic
  $ assistant inference providers default anthropic --connection anthropic-personal`,
        },
      ],
    },
    {
      name: "models",
      description: "Inspect the inference model catalog",
      subcommands: [
        {
          name: "list",
          description: "List catalog models (optionally filtered by provider)",
          options: [
            { flags: "--provider <p>", description: "Filter by provider id" },
            {
              flags: "--json",
              description: "Output as machine-readable JSON",
            },
          ],
          helpText: `
Lists every model in the code-owned provider catalog. Use the ids here
when creating an inference profile:

Examples:
  $ assistant inference models list
  $ assistant inference models list --provider anthropic
  $ assistant inference models list --json`,
        },
      ],
    },
    {
      name: "profiles",
      description: "Manage inference profiles (named model configurations)",
      helpText: `
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
      subcommands: [
        {
          name: "list",
          description: "List the effective profile catalog",
          options: [
            {
              flags: "--json",
              description: "Output as machine-readable JSON",
            },
          ],
        },
        {
          name: "get",
          args: "<name>",
          description: "Show a single effective profile",
          options: [
            {
              flags: "--json",
              description: "Output as machine-readable JSON",
            },
          ],
        },
        {
          name: "create",
          args: "<name>",
          description: "Create a validated custom profile",
          options: profileWriteOptions,
        },
        {
          name: "update",
          args: "<name>",
          description: "Partially update a custom profile",
          options: profileWriteOptions,
        },
        {
          name: "delete",
          args: "<name>",
          description: "Delete a custom profile",
          options: [
            {
              flags: "--json",
              description: "Output as machine-readable JSON",
            },
          ],
        },
        {
          name: "active",
          args: "[name]",
          description: "Read or set the active (chat) profile",
          options: [
            {
              flags: "--json",
              description: "Output as machine-readable JSON",
            },
          ],
          helpText: `
With no argument, prints the active profile. With a name, sets it — the
same deep-merge write the model picker performs.

Examples:
  $ assistant inference profiles active
  $ assistant inference profiles active balanced`,
        },
      ],
    },
    {
      name: "callsites",
      description: "Inspect how each LLM call site resolves to a profile",
      subcommands: [
        {
          name: "list",
          description: "List the effective resolution for every call site",
          options: [
            {
              flags: "--json",
              description: "Output as machine-readable JSON",
            },
          ],
        },
        {
          name: "get",
          args: "<site>",
          description: "Show the resolution detail and chain for one call site",
          options: [
            {
              flags: "--json",
              description: "Output as machine-readable JSON",
            },
          ],
        },
      ],
    },
  ],
};

/** Declarative help for the `assistant llm` alias (exposes only `send`). */
export const llmHelp: CliCommandHelp = {
  name: "llm",
  description: "LLM inference operations (alias for 'inference send')",
  helpText: `
The llm command group is a shorthand for 'assistant inference send'. It sends
requests to your configured LLM provider, resolved from your assistant config
(llm.defaultProvider). For profile session management, use 'assistant inference session'.

Examples:
  $ assistant llm send "What is the capital of France?"
  $ echo "Explain quantum computing" | assistant llm send
  $ assistant llm send --system-prompt "Be concise" "What is TCP?"
  $ assistant llm send --model claude-sonnet-4-20250514 --json "Hello"
  $ assistant llm send --profile balanced "Explain RFC 1149"`,
  subcommands: [sendSubcommandHelp],
};
