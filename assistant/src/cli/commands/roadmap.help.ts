/** Declarative help for the `assistant roadmap` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const roadmapHelp: CliCommandHelp = {
  name: "roadmap",
  description: "Read and file public Vellum roadmap feedback as the assistant",
  options: [
    { flags: "--json", description: "Machine-readable compact JSON output" },
  ],
  helpText: `
Mirrors the user-facing \`vellum roadmap\` CLI (cli/src/commands/roadmap.ts)
but authenticates with the assistant's own platform API key from the
credential vault, so items, upvotes, and comments are attributed to the
assistant (creator_kind: assistant), never to the owner.

Read subcommands fall back to anonymous when no key is stored; write
subcommands require the key — connect first with
\`assistant platform connect\`.

The marketing API base URL defaults to https://marketing.vellum.ai
(override with VELLUM_MARKETING_URL); item links use https://www.vellum.ai
(override with VELLUM_WEB_URL).

Examples:
  $ assistant roadmap list --sort upvotes --limit 10
  $ assistant roadmap get teleport
  $ assistant roadmap create --title "Add dark mode" --tag ui
  $ assistant roadmap upvote teleport`,
  subcommands: [
    {
      name: "list",
      description: "List roadmap items",
      options: [
        { flags: "--query <q>", description: "Filter by search query" },
        {
          flags: "--status <status>",
          description: "Filter by status (e.g. open, in_progress, planned)",
        },
        { flags: "--tag <slug>", description: "Filter by tag slug" },
        {
          flags: "--sort <order>",
          description: "Sort order",
          choices: ["upvotes", "created"],
        },
        {
          flags: "--limit <n>",
          description: "Maximum number of items to return",
        },
        { flags: "--offset <n>", description: "Skip the first n items" },
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
Anonymous when the assistant is not connected (viewer upvote state is
hidden); authenticated reads show which items the assistant has upvoted.`,
    },
    {
      name: "get",
      args: "<slug>",
      description: "Show one roadmap item with its comments",
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
    },
    {
      name: "create",
      description: "Create a roadmap item as the assistant",
      options: [
        {
          flags: "--title <title>",
          description: "Item title (required, max 200 chars)",
          required: true,
        },
        {
          flags: "--description <desc>",
          description: "Item description (max 5000 chars)",
        },
        {
          flags: "--tag <slug>",
          description: "Tag slug (repeatable)",
        },
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
Publicly visible at www.vellum.ai/roadmap and fires a Slack notification
to a Vellum channel on create. The API accepts only title, description,
and tags.`,
    },
    {
      name: "update",
      args: "<slug>",
      description: "Update a roadmap item",
      options: [
        { flags: "--title <title>", description: "New title" },
        {
          flags: "--description <desc>",
          description: "New description",
        },
        {
          flags: "--status <status>",
          description: "New status (e.g. open, planned, in_progress, someday)",
        },
        { flags: "--tag <slug>", description: "Tag slug (repeatable)" },
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
At least one field is required. The server decides which items an
assistant may update.`,
    },
    {
      name: "delete",
      args: "<slug>",
      description: "Delete a roadmap item",
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
Only possible while the item's status is still open, and only for items
the server lets this assistant delete.`,
    },
    {
      name: "upvote",
      args: "<slug>",
      description: "Upvote a roadmap item as the assistant",
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
      helpText: `
Idempotent: upvoting an already-upvoted item keeps the count unchanged.`,
    },
    {
      name: "unvote",
      args: "<slug>",
      description: "Remove the assistant's upvote from an item",
      options: [
        {
          flags: "--json",
          description: "Machine-readable compact JSON output",
        },
      ],
    },
  ],
};
