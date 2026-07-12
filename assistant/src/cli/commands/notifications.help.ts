/** Declarative help for the `assistant notifications` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

export const NOTIFICATION_SOURCE_CHANNEL_VALUES = [
  "assistant_tool",
  "vellum",
  "phone",
  "telegram",
  "slack",
  "scheduler",
  "watcher",
] as const;

export const URGENCY_VALUES = ["low", "medium", "high", "critical"] as const;

export const NOTIFICATION_STATUS_VALUES = [
  "new",
  "seen",
  "acted_on",
  "dismissed",
] as const;

export const NOTIFICATION_CATEGORY_VALUES = [
  "security",
  "scheduling",
  "background",
  "email",
  "system",
] as const;

export const DEFAULT_SOURCE_CHANNEL = "assistant_tool";
const SOURCE_CHANNEL_HELP = NOTIFICATION_SOURCE_CHANNEL_VALUES.join(", ");
const URGENCY_HELP = URGENCY_VALUES.join(", ");
const STATUS_HELP = NOTIFICATION_STATUS_VALUES.join(", ");
const CATEGORY_HELP = NOTIFICATION_CATEGORY_VALUES.join(", ");

export const notificationsHelp: CliCommandHelp = {
  name: "notifications",
  description:
    "Send and inspect notifications through the unified notification router",
  options: [
    { flags: "--json", description: "Machine-readable compact JSON output" },
  ],
  helpText: `
Notifications flow through a unified pipeline: a signal is emitted with a
source channel, event name, and attention hints. The decision engine evaluates
whether and where to deliver the notification based on connected channels,
urgency, and user preferences.

Minimal usage: only --message is required. Add --urgent for a push + visual
flag in the inbox. Source channel/event name fall back to assistant_tool /
assistant.share when omitted.

Examples:
  $ assistant notifications send --message "Build finished"
  $ assistant notifications send --message "Pager: prod is down" --urgent
  $ assistant notifications send --message "Build green" --conversation-id 649c4645-3a6f-4ded-a713-504f02ca806b`,
  subcommands: [
    {
      name: "send",
      description:
        "Send a notification through the unified notification router. Only --message is required; pass --urgent for a push + visual flag.",
      options: [
        {
          flags: "--message <message>",
          description:
            "Notification body. Markdown (GFM) renders in the detail panel; the OS banner shows plain text.",
          required: true,
        },
        {
          flags: "--urgent",
          description:
            "Mark this notification as urgent (fires push + visual flag in inbox)",
          defaultValue: false,
        },
        {
          flags: "--source-channel <channel>",
          description: `Source channel producing this notification. One of: ${SOURCE_CHANNEL_HELP} (default: ${DEFAULT_SOURCE_CHANNEL})`,
        },
        {
          flags: "--source-event-name <name>",
          description:
            "Event name for audit, routing, and dedupe grouping (default: assistant.share)",
        },
        {
          flags: "--title <title>",
          description:
            "Short headline (≤ 8 words). Always provide one — the auto-derived fallback just truncates --message.",
        },
        {
          flags: "--urgency <urgency>",
          description: `Urgency hint. One of: ${URGENCY_HELP} (default: low; use --urgent for critical)`,
        },
        {
          flags: "--requires-action",
          description:
            "Whether the notification expects user action (default: false; use --urgent to force true)",
        },
        {
          flags: "--no-requires-action",
          description: "Mark that the notification does not expect user action",
        },
        {
          flags: "--is-async-background",
          description:
            "Whether the event is asynchronous/background work (default: false)",
        },
        {
          flags: "--no-is-async-background",
          description:
            "Mark that the event is not asynchronous/background work",
        },
        {
          flags: "--visible-in-source-now",
          description:
            "Set true when user is already viewing the source context (default: false)",
        },
        {
          flags: "--no-visible-in-source-now",
          description: "Mark that the user is not viewing the source context",
        },
        {
          flags: "--deadline-at <epoch>",
          description: "Optional deadline timestamp in epoch milliseconds",
        },
        {
          flags: "--preferred-channels <channels>",
          description:
            "Comma-separated channel hints (e.g. vellum,telegram,slack)",
        },
        {
          flags: "--session-id <id>",
          description:
            "Source session or conversation ID (default: cli-<timestamp>)",
        },
        {
          flags: "--dedupe-key <key>",
          description:
            "Optional dedupe key to suppress duplicate notifications",
        },
        {
          flags: "--deep-link-metadata <json>",
          description:
            "Optional JSON metadata clients can use for deep linking",
        },
        {
          flags: "--conversation-id <id>",
          description:
            "Local vellum conversation ID to deliver into. When set, the notification reuses the specified conversation instead of starting a new one — bypasses the LLM's conversation-routing decision via affinity hint.",
        },
      ],
      helpText: `
Arguments:
  --message            The notification body text (required, must be non-empty)
  --urgent             Shortcut that maps to urgency=critical + requires-action=true

Behavioral notes:
  - The signal is emitted through the full notification pipeline: event store,
    decision engine, deterministic checks, and channel dispatch.
  - --urgent overrides --urgency and --requires-action defaults so the signal
    is treated as critical and requires user action. Explicit --urgency /
    --requires-action flags still win for back-compat.
  - Without --urgent, --urgency defaults to low and --requires-action to false.
  - --preferred-channels are hints only; the decision engine may override them.
  - --dedupe-key suppresses duplicate signals with the same key.
  - --conversation-id pins delivery to an existing vellum conversation
    deterministically. Other channels (telegram, slack) continue to use
    binding-based pairing for their external threads.

Examples:
  $ assistant notifications send --message "Task complete"
  $ assistant notifications send --message "Pager: prod is down" --urgent
  $ assistant notifications send --message "Build green" --conversation-id 649c4645-3a6f-4ded-a713-504f02ca806b`,
    },
    {
      name: "list",
      description:
        "List notifications surfaced to the user via the home feed. Excludes dismissed items by default.",
      options: [
        {
          flags: "--all",
          description:
            "Include dismissed items (default: only new/seen/acted_on)",
          defaultValue: false,
        },
        {
          flags: "--status <status>",
          description: `Filter by status. One of: ${STATUS_HELP}; repeatable. Overrides --all default behavior.`,
        },
        {
          flags: "--before <iso>",
          description:
            "Only items with createdAt strictly before this ISO-8601 timestamp",
        },
        {
          flags: "--after <iso>",
          description:
            "Only items with createdAt strictly after this ISO-8601 timestamp",
        },
        {
          flags: "--urgency <urgency>",
          description: `Filter by urgency. One of: ${URGENCY_HELP}; repeatable`,
        },
        {
          flags: "--category <category>",
          description: `Filter by category. One of: ${CATEGORY_HELP}; repeatable`,
        },
        {
          flags: "--conversation-id <id>",
          description: "Only items tied to this conversation id",
        },
        {
          flags: "--from-assistant",
          description: "Only items emitted by the assistant",
          defaultValue: false,
        },
        {
          flags: "--noteworthy",
          description: "Only items flagged as noteworthy",
          defaultValue: false,
        },
        {
          flags: "--limit <n>",
          description:
            "Maximum number of items to return (default: 20, max: 200)",
        },
        {
          flags: "--offset <n>",
          description: "Pagination offset (default: 0)",
        },
      ],
      helpText: `
Reads the home feed at $VELLUM_WORKSPACE_DIR/data/home-feed.json — the
user's notification inbox. Items are ordered by priority then recency,
matching what the user sees in the macOS Home page. The home feed covers
background/async notifications mirrored from the unified pipeline;
real-time chat pushes that did not mirror to the feed will not appear.

Examples:
  $ assistant notifications list
  $ assistant notifications list --all
  $ assistant notifications list --status new --status seen
  $ assistant notifications list --after 2026-05-28T00:00:00Z --urgency high
  $ assistant notifications list --conversation-id 7fab234c --json
  $ assistant notifications list --limit 5 --offset 5`,
    },
    {
      name: "edit",
      description:
        "Edit an already-sent notification. Patches the home-feed entry and updates the delivered channel message in place where supported (Slack today).",
      options: [
        {
          flags: "--id <id>",
          description:
            "Feed item id (notif:<uuid>) from `notifications list --json`. Bare uuids without the `notif:` prefix are also accepted.",
          required: true,
        },
        {
          flags: "--message <message>",
          description:
            "New notification body. Updates the home-feed summary and the delivered channel message text where supported.",
        },
        {
          flags: "--title <title>",
          description: "New short headline (≤ 8 words).",
        },
        {
          flags: "--urgency <urgency>",
          description: `Set urgency. One of: ${URGENCY_HELP}. Feed-only — does not re-push channel messages.`,
        },
        {
          flags: "--status <status>",
          description: `Set lifecycle status. One of: ${STATUS_HELP}. Feed-only.`,
        },
      ],
      helpText: `
At least one of --message, --title, --urgency, or --status must be
supplied. --urgency and --status only update the home-feed entry —
they never re-push channel messages.

Channel updates are best-effort: Slack messages get updated via
chat.update; other channels (push, email, SMS) cannot be edited and
are reported as "unsupported".

Examples:
  $ assistant notifications edit --id notif:abc12345-... --message "Fixed body"
  $ assistant notifications edit --id abc12345-... --title "Backup complete"
  $ assistant notifications edit --id notif:abc12345-... --urgency low
  $ assistant notifications edit --id notif:abc12345-... --status dismissed`,
    },
  ],
};
