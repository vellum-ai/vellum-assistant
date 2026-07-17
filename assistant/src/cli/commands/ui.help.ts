/** Declarative help for the `assistant ui` command. */

import type { CliCommandHelp } from "../lib/cli-command-help.js";

/**
 * Default request timeout in milliseconds (5 minutes). This is the time
 * the daemon will wait for the user to respond before the surface
 * auto-cancels with `status: "timed_out"`.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5m

/**
 * Default timeout for `ui snapshot` (30s). Sized for a hidden-window render
 * and capture, not a human response.
 */
export const DEFAULT_SNAPSHOT_TIMEOUT_MS = 30_000;

export const uiHelp: CliCommandHelp = {
  name: "ui",
  description: "Present interactive UI surfaces to the user",
  helpText: `
Script-facing commands that present interactive surfaces (confirmations,
forms) to the user via the running assistant and block until the user
responds or the request times out.

The conversation ID is resolved automatically when running inside a skill
or bash tool context (__SKILL_CONTEXT_JSON or __CONVERSATION_ID).
Override with --conversation-id if needed.

Examples:
  $ echo '{"message":"Delete all logs?"}' | assistant ui request --json
  $ assistant ui confirm --title "Deploy to production?" --message "This will push to prod."
  $ assistant ui confirm --message "Are you sure?" --json`,
  subcommands: [
    {
      name: "request",
      description:
        "Present an interactive surface and block until the user responds",
      options: [
        {
          flags: "--payload <json>",
          description: "JSON object describing the surface data",
        },
        {
          flags: "--surface-type <type>",
          description: 'Surface type: "confirmation" or "form"',
          defaultValue: "confirmation",
        },
        {
          flags: "--title <title>",
          description: "Title displayed on the surface",
        },
        {
          flags: "--actions <json>",
          description:
            "JSON array of action objects defining custom buttons/options",
        },
        {
          flags: "--conversation-id <id>",
          description:
            "Conversation ID — run 'assistant conversations list' to find it (auto-resolved from skill or bash tool context if omitted)",
        },
        {
          flags: "--timeout <ms>",
          description: "Request timeout in milliseconds",
          defaultValue: String(DEFAULT_REQUEST_TIMEOUT_MS),
        },
        {
          flags: "--json",
          description: "Output result as machine-readable JSON",
        },
      ],
      helpText: `
Sends a UI interaction request to the running assistant and blocks until
the user responds or the timeout elapses. The payload describes the
surface content and can be provided via --payload or piped through stdin.

The response includes the user's action (submitted, cancelled, timed_out)
and any submitted data.

Custom actions can be defined via --actions to control the buttons shown
on the surface. Each action requires an "id" and "label", with an optional
"variant" hint ("primary", "danger", or "secondary").

Arguments:
  (none — payload via --payload flag or stdin)

Options:
  --payload <json>         JSON object with surface data
  --surface-type <type>    "confirmation" (default) or "form"
  --title <title>          Surface title
  --actions <json>         JSON array of custom action objects
  --conversation-id <id>   Explicit conversation ID
  --timeout <ms>           Request timeout in milliseconds (default: 300000)
  --json                   Output as JSON

Examples:
  $ echo '{"message":"Proceed?"}' | assistant ui request
  $ assistant ui request --payload '{"message":"Proceed?"}' --json
  $ assistant ui request --payload '{"fields":[]}' --surface-type form --json
  $ assistant ui request --payload '{"message":"Choose an option"}' \\
      --actions '[{"id":"approve","label":"Approve","variant":"primary"},{"id":"reject","label":"Reject","variant":"danger"}]'`,
    },
    {
      name: "confirm",
      description:
        "Present a yes/no confirmation prompt; exits 0 on confirm, 1 on deny/cancel/timeout",
      options: [
        {
          flags: "--title <title>",
          description: "Title displayed on the confirmation prompt",
        },
        {
          flags: "--message <message>",
          description: "Message body shown in the confirmation prompt",
        },
        {
          flags: "--confirm-label <label>",
          description: 'Label for the confirm button (default: "Confirm")',
          defaultValue: "Confirm",
        },
        {
          flags: "--deny-label <label>",
          description: 'Label for the deny button (default: "Deny")',
          defaultValue: "Deny",
        },
        {
          flags: "--conversation-id <id>",
          description:
            "Conversation ID — run 'assistant conversations list' to find it (auto-resolved from skill or bash tool context if omitted)",
        },
        {
          flags: "--timeout <ms>",
          description: "Request timeout in milliseconds",
          defaultValue: String(DEFAULT_REQUEST_TIMEOUT_MS),
        },
        {
          flags: "--json",
          description: "Output result as machine-readable JSON",
        },
      ],
      helpText: `
Ergonomic wrapper around "ui request" for binary yes/no gating. Presents
a confirmation surface to the user and blocks until they respond.

Exit codes:
  0  — User confirmed
  1  — User denied, cancelled, or the request timed out

The --json flag outputs the full interaction result for scripts that need
to inspect the response details.

Options:
  --title <title>            Prompt title
  --message <message>        Prompt body text
  --confirm-label <label>    Confirm button label (default: "Confirm")
  --deny-label <label>       Deny button label (default: "Deny")
  --conversation-id <id>     Explicit conversation ID
  --timeout <ms>             Request timeout in ms (default: 300000)
  --json                     Output as JSON

Examples:
  $ assistant ui confirm --message "Delete all data?"
  $ assistant ui confirm --title "Deploy" --message "Push to prod?" --json
  $ assistant ui confirm --message "Proceed?" --confirm-label "Yes" --deny-label "No"`,
    },
    {
      name: "snapshot",
      description:
        "Capture a PNG of a staged app view with the current workspace theme applied",
      options: [
        {
          flags: "--view <view>",
          description: 'Staged composition to capture: "sampler" or "chat"',
          defaultValue: "sampler",
        },
        {
          flags: "--out <path>",
          description: "File path to write the PNG to",
        },
        {
          flags: "--timeout <ms>",
          description: "How long to wait for the desktop client capture",
          defaultValue: String(DEFAULT_SNAPSHOT_TIMEOUT_MS),
        },
        {
          flags: "--json",
          description:
            "Output result as machine-readable JSON (PNG inline as base64)",
        },
      ],
      helpText: `
Asks the connected desktop app to render a staged view of its own UI —
fixed generic content, no user data — with the workspace theme from
ui/theme.json applied, capture it offscreen, and return the PNG. Use it
to see theming work without asking the user for screenshots.

Views:
  sampler  Dense style sheet: text ramp, accent, buttons, card, inputs,
           borders, chat bubbles. Answers "does the palette read".
  chat     A staged conversation with a composer. Answers "does it feel
           like the app".

Requires the desktop app to be running. If the workspace theme file is
invalid, the capture shows the built-in theme and the validation issues
are printed.

Examples:
  $ assistant ui snapshot --view sampler --out /tmp/theme-sampler.png
  $ assistant ui snapshot --view chat --out /tmp/theme-chat.png`,
    },
  ],
};
