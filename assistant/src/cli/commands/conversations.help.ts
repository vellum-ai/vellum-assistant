/** Declarative help for the `assistant conversations` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const conversationsHelp: CliCommandHelp = {
  name: "conversations",
  description: "Manage conversations",
  helpText: `
Conversations with the assistant. Each conversation has a unique ID and a
title. All subcommands communicate via IPC and require the assistant to be
running.

Examples:
  $ assistant conversations list
  $ assistant conversations new "Project planning"
  $ assistant conversations export
  $ assistant conversations clear`,
  subcommands: [
    {
      name: "import",
      description: "Import conversations from a standard JSON format",
      options: [
        {
          flags: "--file <path>",
          description: "Read JSON from file instead of stdin",
        },
        {
          flags: "--json",
          description: "Output result as machine-readable JSON",
        },
      ],
      helpText: `
Imports conversations into the assistant from a standard JSON format.
Reads from stdin by default, or from a file with --file.

The input JSON must have the shape:
  { "conversations": [{ "title": "...", "messages": [...] }] }

Each conversation may include:
  sourceKey         External key for dedup (e.g. "chatgpt:abc123")
  createdAt         Unix epoch milliseconds for the conversation
  updatedAt         Unix epoch milliseconds for the conversation
  messages[].role   "user" or "assistant"
  messages[].content  String or array of {type, text} content blocks
  messages[].createdAt  Unix epoch milliseconds for the message

Messages are indexed for memory search after import. Re-importing with
the same sourceKey will skip already-imported conversations.

Examples:
  $ bun run scripts/parse-export.ts --file export.zip | assistant conversations import --json
  $ assistant conversations import --file import.json --json
  $ cat data.json | assistant conversations import`,
    },
    {
      name: "defer",
      args: "[conversationId]",
      description: "Create a deferred wake for a conversation",
      options: [
        {
          flags: "--in <duration>",
          description: "Delay before firing (e.g. 60, 60s, 5m, 1h)",
        },
        {
          flags: "--at <iso8601>",
          description: "Absolute ISO 8601 fire time",
        },
        {
          flags: "--hint <text>",
          description: "Hint message for the wake",
        },
        {
          flags: "--name <text>",
          description: "Name for the deferred wake",
          defaultValue: "Deferred wake",
        },
        {
          flags: "--json",
          description: "Output result as JSON",
        },
      ],
      helpText: `
Create a deferred wake that fires after a delay or at a specific time.
The conversation ID is resolved from the positional argument, the
$__SKILL_CONTEXT_JSON env var, or $__CONVERSATION_ID.

Requires the assistant to be running. Communicates via IPC socket.

Examples:
  $ assistant conversations defer --in 60 --hint "check progress"
  $ assistant conversations defer conv-123 --in 5m --hint "follow up"
  $ assistant conversations defer --at 2026-04-23T15:00:00Z --hint "meeting time"
  $ assistant conversations defer --in 1h30m --hint "remind me" --json`,
      subcommands: [
        {
          name: "list",
          description: "List pending deferred wakes",
          options: [
            {
              flags: "--conversation-id <id>",
              description: "Filter by conversation ID",
            },
            {
              flags: "--json",
              description: "Output result as JSON",
            },
          ],
          helpText: `
List all pending deferred wakes, optionally filtered by conversation ID.

Requires the assistant to be running. Communicates via IPC socket.

Examples:
  $ assistant conversations defer list
  $ assistant conversations defer list --conversation-id conv-123
  $ assistant conversations defer list --json`,
        },
        {
          name: "cancel",
          args: "[deferId]",
          description: "Cancel a deferred wake by ID, or all with --all",
          options: [
            {
              flags: "--all",
              description: "Cancel all pending deferred wakes",
            },
            {
              flags: "--conversation-id <id>",
              description: "Filter by conversation ID (with --all)",
            },
            {
              flags: "--json",
              description: "Output result as JSON",
            },
          ],
          helpText: `
Cancel a single deferred wake by ID, or all pending wakes with --all.

Requires the assistant to be running. Communicates via IPC socket.

Examples:
  $ assistant conversations defer cancel <deferId>
  $ assistant conversations defer cancel --all
  $ assistant conversations defer cancel --all --conversation-id conv-123
  $ assistant conversations defer cancel --all --json`,
        },
      ],
    },
    {
      name: "list",
      description: "List conversations (excludes archived by default)",
      options: [
        {
          flags: "--include-archived",
          description: "Include archived conversations in the output",
        },
      ],
      helpText: `
Shows conversations with their ID, title, and a relative timestamp (e.g.
"3 hours ago"). Conversations are listed in order of most recently updated.
Rows currently mid-turn — i.e. the agent loop is actively running on the
in-memory conversation — are prefixed with "●"; idle rows are prefixed
with " " (two spaces) so columns stay aligned.

Archived conversations are excluded by default; pass --include-archived to
include them.

Examples:
  $ assistant conversations list
  $ assistant conversations list --include-archived`,
    },
    {
      name: "new",
      args: "[title]",
      description: "Create a new conversation",
      options: [
        {
          flags: "--content-file <path>",
          description: "Seed messages from a JSON file",
        },
        {
          flags: "--json",
          description: "Output result as JSON",
        },
      ],
      helpText: `
Arguments:
  title   Optional conversation title (string). If omitted, a default title is
          assigned by the assistant.

The content file must be a JSON array of { role, content } messages.

Creates a new conversation and prints its title, ID, and generated conversation
key.

Examples:
  $ assistant conversations new
  $ assistant conversations new "Project planning"
  $ assistant conversations new --content-file /tmp/seed.json
  $ assistant conversations new "Bug triage 2026-03-05"`,
    },
    {
      name: "rename",
      args: "<conversationId> <title>",
      description: "Rename a conversation",
      helpText: `
Arguments:
  conversationId   Conversation ID (or unique prefix). Supports prefix matching.
                   Run 'assistant conversations list' to find IDs.
  title            The new title for the conversation. Should be concise (under
                   60 characters) and descriptive of the current topic.

Renames the conversation to the given title and marks it as a manual rename
(auto-generated titles will not overwrite it).

Examples:
  $ assistant conversations rename abc123 "Project planning"
  $ assistant conversations rename abc123 "Bug triage 2026-04-22"`,
    },
    {
      name: "export",
      args: "[conversationId]",
      description: "Export a conversation as markdown or JSON",
      options: [
        {
          flags: "-f, --format <format>",
          description: "Output format: md or json",
          defaultValue: "md",
        },
        {
          flags: "-o, --output <file>",
          description: "Write to file instead of stdout",
        },
      ],
      helpText: `
Arguments:
  conversationId   Optional conversation ID (or unique prefix). Defaults to the
                   most recent conversation. Supports prefix matching — e.g.
                   "abc123" matches the first conversation whose ID starts with
                   "abc123". Run 'assistant conversations list' to find IDs.

Two output formats are available:
  md    Markdown conversation transcript (default). Human-readable rendering
        of messages with role headers.
  json  Structured JSON export with full metadata, message content arrays,
        and timestamps.

Examples:
  $ assistant conversations export
  $ assistant conversations export --format json -o conversation.json
  $ assistant conversations export abc123 --format md`,
    },
    {
      name: "slack",
      description: "Manage Slack conversation bindings",
      subcommands: [
        {
          name: "detach",
          args: "[conversationId]",
          description: "Detach the assistant from a Slack thread",
          options: [
            {
              flags: "--channel <id>",
              description: "Slack channel ID",
            },
            {
              flags: "--thread <ts>",
              description: "Slack thread timestamp",
            },
            {
              flags: "--json",
              description: "Output result as JSON",
            },
          ],
          helpText: `
Arguments:
  conversationId   Optional conversation ID. Defaults to the current skill or
                   tool conversation when available.

Detaches the assistant from Socket Mode listening for the Slack thread bound
to a conversation, or for explicit --channel and --thread identifiers.

Examples:
  $ assistant conversations slack detach
  $ assistant conversations slack detach conv-123
  $ assistant conversations slack mute --channel C123 --thread 1700000000.000100
  $ assistant conversations slack detach --json`,
        },
      ],
    },
    {
      name: "clear",
      description:
        "Clear all conversations, messages, and vector data (dev only)",
      helpText: `
Permanently deletes ALL conversations, messages, and associated data.
Prompts for confirmation (y/N) before proceeding.

Requires the assistant to be running. Communicates via IPC socket.

Intended for development use. This action cannot be undone.

Examples:
  $ assistant conversations clear`,
    },
    {
      name: "wake",
      args: "<conversationId>",
      description:
        "Wake the agent on an existing conversation with an internal hint",
      options: [
        {
          flags: "--hint <text>",
          description:
            "Hint message visible to the LLM (not persisted to transcript)",
          required: true,
        },
        {
          flags: "--source <label>",
          description: "Source label for logging (e.g. github-notification)",
          defaultValue: "cli",
        },
        {
          flags: "--persist",
          description:
            "Persist the trigger as a transcript-visible background event instead of an ephemeral hint",
        },
        {
          flags: "--external-content <string>",
          description:
            "Raw third-party data to fence as untrusted content (implies --persist). The caller reads the data and passes it as a string. Visible in the process table (ps) and bounded by ARG_MAX",
        },
        {
          flags: "--json",
          description: "Output result as JSON",
        },
      ],
      helpText: `
Arguments:
  conversationId   Conversation ID to wake.

Wake the assistant's agent loop on an existing conversation without a user
message. The hint is injected as a non-persisted internal message visible
only to the LLM — it never appears in the transcript or SSE feed. If the
agent produces output (text or tool calls), it is persisted and emitted to
connected clients. Otherwise the wake is a silent no-op.

--hint is TRUSTED framing authored by you. Any attacker-influenceable data
(email bodies, PR text, fetched web pages, notification payloads) MUST be
passed via --external-content — never inlined into --hint. Untrusted content is
fenced inside <external_content> so the model treats it as data, never
instructions, and implies --persist. The caller reads the data and passes it as
a string; it is visible in the process table via 'ps' and bounded by ARG_MAX.

Requires the assistant to be running. Communicates via IPC socket.

Examples:
  $ assistant conversations wake abc123 --hint "PR #25933 received a review requesting changes"
  $ assistant conversations wake abc123 --hint "CI failed on commit abc" --source github-ci
  $ assistant conversations wake abc123 --hint "New Slack DM from Vargas" --source slack --json
  $ assistant conversations wake abc123 --hint "New Slack msgs to triage" --external-content "$slack_dump"`,
    },
  ],
};
