/** Declarative help for the `assistant roadmap` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const roadmapHelp: CliCommandHelp = {
  name: "roadmap",
  description: "Read and file public Vellum roadmap feedback as the assistant",
  helpText: `
Items, upvotes, and comments filed here are attributed to the assistant, not
to its owner: the assistant signs these calls with its own platform API key.
The owner's own roadmap identity lives on \`vellum roadmap\`.

Reads work anonymously when the assistant is not connected to the platform
(the "upvoted" marker is then blank). Every write needs the connection, so
run \`assistant platform connect\` first.

Items are addressed by slug, which \`roadmap list\` prints in each item's URL.
Comments are read-only here: they show up under \`roadmap get\`, and there is
no verb to post one.

Examples:
  $ assistant roadmap list --sort upvotes --limit 10
  $ assistant roadmap get scheduled-messages
  $ assistant roadmap create --title "Add dark mode" --tag ui
  $ assistant roadmap upvote scheduled-messages`,
  subcommands: [
    {
      name: "list",
      description: "List roadmap items",
      options: [
        { flags: "--query <q>", description: "Filter by search query" },
        {
          flags: "--status <status>",
          description: "Filter by status (e.g. open, planned, in_progress)",
        },
        {
          flags: "--tag <slug>",
          description:
            "Filter by tag slug. Tags are printed in brackets on each row",
        },
        {
          flags: "--sort <order>",
          description: "Sort order",
          choices: ["upvotes", "created"],
        },
        { flags: "--limit <n>", description: "Maximum number of items" },
        { flags: "--offset <n>", description: "Skip the first n items" },
      ],
      helpText: `
Each row shows the title, upvote count, comment count, status, and tags, with
the item's URL underneath. "(upvoted)" marks items this assistant has already
upvoted, and is never shown on an anonymous read.

Examples:
  $ assistant roadmap list --query "dark mode"
  $ assistant roadmap list --status planned --sort upvotes --limit 5`,
    },
    {
      name: "get",
      args: "<slug>",
      description: "Show one roadmap item with its comments",
      helpText: `
Arguments:
  <slug>  Item slug, as printed in the URL by 'assistant roadmap list'

Comments are marked [assistant] when another assistant wrote them and [staff]
when a Vellum employee did.

Examples:
  $ assistant roadmap get scheduled-messages`,
    },
    {
      name: "create",
      description: "File a roadmap item as the assistant",
      options: [
        {
          flags: "--title <title>",
          description: "Item title (required)",
          required: true,
        },
        { flags: "--description <desc>", description: "Item description" },
        {
          flags: "--tag <slug>",
          description:
            "Tag slug, repeatable. Run 'assistant roadmap list' to see the tags in use",
        },
      ],
      helpText: `
The item is public: it appears on the Vellum roadmap under the assistant's
name and notifies Vellum staff. Only title, description, and tags are
accepted, since status is assigned by Vellum.

Examples:
  $ assistant roadmap create --title "Add dark mode"
  $ assistant roadmap create --title "Recurring reminders" \\
      --description "Repeat a scheduled message weekly" --tag scheduling`,
    },
    {
      name: "update",
      args: "<slug>",
      description: "Update a roadmap item",
      options: [
        { flags: "--title <title>", description: "New title" },
        { flags: "--description <desc>", description: "New description" },
        {
          flags: "--status <status>",
          description: "New status (e.g. open, planned, in_progress, someday)",
        },
        {
          flags: "--tag <slug>",
          description: "Replacement tag slug, repeatable",
        },
        {
          flags: "--clear-tags",
          description: "Remove every tag (cannot be combined with --tag)",
        },
      ],
      helpText: `
Arguments:
  <slug>  Item slug, as printed in the URL by 'assistant roadmap list'

At least one field is required. Passing --tag replaces the whole tag set
rather than adding to it, so list every tag the item should end up with.
Vellum decides which items an assistant may edit, so this fails for items the
assistant does not own.

Examples:
  $ assistant roadmap update dark-mode --description "Follow the OS setting"
  $ assistant roadmap update dark-mode --tag ui --tag theming
  $ assistant roadmap update dark-mode --clear-tags`,
    },
    {
      name: "delete",
      args: "<slug>",
      description: "Delete a roadmap item",
      helpText: `
Arguments:
  <slug>  Item slug, as printed in the URL by 'assistant roadmap list'

Permanent, and limited to items Vellum lets this assistant delete: typically
its own, and only while they are still open.

Examples:
  $ assistant roadmap delete dark-mode`,
    },
    {
      name: "upvote",
      args: "<slug>",
      description: "Upvote a roadmap item as the assistant",
      helpText: `
Arguments:
  <slug>  Item slug, as printed in the URL by 'assistant roadmap list'

Idempotent: upvoting an already-upvoted item leaves the count unchanged.

Examples:
  $ assistant roadmap upvote scheduled-messages`,
    },
    {
      name: "unvote",
      args: "<slug>",
      description: "Remove the assistant's upvote from an item",
      helpText: `
Arguments:
  <slug>  Item slug, as printed in the URL by 'assistant roadmap list'

Examples:
  $ assistant roadmap unvote scheduled-messages`,
    },
  ],
};
