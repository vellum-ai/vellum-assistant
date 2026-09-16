/**
 * Declarative help for the `assistant browser` command.
 *
 * The per-operation subcommands are derived from {@link BROWSER_OPERATION_META}
 * — the browser operations contract is the single source of truth for their
 * names, flags, and help text, so the derived help cannot drift from the
 * operations the daemon actually supports.
 */

// operation-meta is an execution-free data leaf (no Playwright imports),
// consumed synchronously to derive this module's constant — pure data from
// pure data, so a lazy `import()` has nothing to defer. Kept out of the
// heavier `browser/operations` barrel on purpose.
// eslint-disable-next-line cli/no-daemon-internals
import { BROWSER_OPERATION_META } from "../../browser/operation-meta.js";
import type {
  BrowserOperationMeta,
  OperationField,
} from "../../browser/types.js";
import { DESKTOP_HELP_GUIDANCE } from "../../util/browser-human-verification.js";
import type {
  CliCommandHelp,
  CliOptionHelp,
  CliSubcommandHelp,
} from "../lib/cli-command-help.js";

// ── Naming helpers ───────────────────────────────────────────────────

/**
 * Convert a snake_case operation name to kebab-case for CLI subcommand
 * names (e.g. `press_key` -> `press-key`).
 */
export function toKebab(snakeCase: string): string {
  return snakeCase.replace(/_/g, "-");
}

/**
 * Convert a snake_case field name to a kebab-case CLI option flag
 * (e.g. `allow_private_network` -> `--allow-private-network`).
 *
 * Boolean fields declare only `--flag`; Commander 13 auto-generates
 * the `--no-flag` negation variant. Declaring both in a single spec
 * string (e.g. `--flag, --no-flag`) breaks in Commander 13 because
 * `--flag` still parses to `false`.
 */
function fieldToFlag(field: OperationField): string {
  const kebab = toKebab(field.name);
  if (field.type === "boolean") {
    return `--${kebab}`;
  }
  return `--${kebab} <${field.type === "number" ? "number" : "value"}>`;
}

/**
 * Valid browser mode values for the --browser-mode option.
 * Includes canonical values and compatibility aliases accepted by
 * `normalizeBrowserMode` (cdp-debugger → cdp-inspect, playwright → local).
 */
const BROWSER_MODES = [
  "auto",
  "extension",
  "cdp-inspect",
  "cdp-debugger",
  "local",
  "playwright",
] as const;

// ── Per-operation subcommand derivation ──────────────────────────────

function operationToSubcommand(meta: BrowserOperationMeta): CliSubcommandHelp {
  const options: CliOptionHelp[] = meta.fields.map((field) => ({
    flags: fieldToFlag(field),
    description: field.description,
    ...(field.required ? { required: true } : {}),
    ...(field.enum ? { choices: [...field.enum] } : {}),
  }));

  // screenshot gets an --output <path> option for writing JPEG to disk
  if (meta.operation === "screenshot") {
    options.push({
      flags: "--output <path>",
      description: "Write the screenshot JPEG to a file path on disk.",
    });
  }

  return {
    name: toKebab(meta.operation),
    description: meta.description,
    ...(options.length > 0 ? { options } : {}),
    ...(meta.helpText ? { helpText: `\n${meta.helpText}` } : {}),
  };
}

// ── Command help ─────────────────────────────────────────────────────

export const browserHelp: CliCommandHelp = {
  name: "browser",
  description: "Control the browser via the running assistant.",
  options: [
    {
      flags: "--desktop",
      description: "Compatibility alias for --virtual-desktop.",
    },
    {
      flags: "--virtual-desktop",
      description:
        "Use Chrome in the platform-hosted virtual desktop with visible cursor feedback.",
    },
    {
      flags: "--session <id>",
      description: "Session ID to preserve browser state across invocations.",
      defaultValue: "default",
    },
    {
      flags: "--json",
      description: "Output results as machine-readable JSON.",
    },
    {
      flags: "--browser-mode <mode>",
      description: "Browser backend to use. Overrides automatic selection.",
      choices: BROWSER_MODES,
    },
    {
      flags: "--target-client-id <id>",
      description:
        "Route browser operations to a specific client. Obtain IDs from `assistant clients list --capability host_browser`.",
    },
  ],
  helpText: `
Browser operations are executed through the running assistant.
Virtual desktop is available only for platform-hosted assistants.
In the web client, automatic selection prefers virtual desktop Chrome when
its feature is enabled and the conversation has an
identified guardian. The macOS and Windows apps keep their existing browser
selection and fallback behavior; use --virtual-desktop to select it there.
Existing sessions and explicit backend/client choices take priority.
--browser-mode local (alias playwright) means the assistant's Playwright browser,
not the user's Chrome. --desktop remains an alias for --virtual-desktop.
Use --virtual-desktop for Chrome in the Desktop panel.
Run navigate --url <url> directly to open a page.
The assistant-desktop feature flag and completed installation are required.
The first browser command installs missing components, starts Chrome, and completes
the requested action in one call. Allow up to 600 seconds for this command when
using bash (timeout_seconds: 600). Opening the Desktop panel also starts
the same installation and shows progress. No separate setup command is needed.
Report other availability errors without switching to a personal computer.
The assistant manages Chrome startup. Do not launch a separate desktop stack,
install desktop packages, or drive webpages with shell-level xdotool.
With --virtual-desktop, screenshot captures the page directly from Chrome over CDP
as a color JPEG. Use --output to save it and file_read to view it. Do not use
shell-level xwd or custom screenshot conversion scripts.
Use snapshot for current element IDs and tabs list for current tab IDs.
Refresh the snapshot after navigation, tab changes or stale-element errors.
Inspect the result before retrying a failed action; it may have happened.
A purple page pointer shows CDP mouse movement in the stream. Browser toolbar
controls, native dialogs and other apps are outside this CLI's page controls.
Do not combine --virtual-desktop with personal browser targets, other browser modes
or --use-active-tab. Download waiting is unavailable on this target.
Users can interact directly with the expanded desktop. If they ask you to pause,
stop and wait. Take a fresh snapshot before resuming. Closing the viewer does not
end automation. Run assistant browser --virtual-desktop detach when finished or
blocked. Chrome stays running.
For logins, use saved credentials first. Securely collect missing credentials
with assistant credentials prompt, then fill the login form yourself.
${DESKTOP_HELP_GUIDANCE}
Each subcommand maps to a browser operation and communicates
with the assistant process.

The --session flag groups sequential commands so they share browser
state (same page, cookies, etc.). Different session IDs create
independent browser contexts.

The --browser-mode flag pins the browser backend for all operations
in the invocation. Valid modes: auto (default), extension, cdp-inspect,
local. Useful for debugging or when deterministic backend selection
is required.

Examples:
  $ assistant browser --virtual-desktop status
  $ assistant browser --virtual-desktop screenshot --output /tmp/desktop-page.jpg
  $ assistant browser navigate --url https://example.com
  $ assistant browser snapshot
  $ assistant browser click --selector "#login"
  $ assistant browser type --text "hello" --element-id e14
  $ assistant browser screenshot --output page.jpg
  $ assistant browser --session myflow navigate --url https://example.com
  $ assistant browser --browser-mode local navigate --url http://localhost:3000
  $ assistant browser --json screenshot`,
  subcommands: [
    ...BROWSER_OPERATION_META.map(operationToSubcommand),
    {
      name: "tabs",
      description: "Manage browser tabs",
      subcommands: [
        {
          name: "list",
          description: "List all open browser tabs",
          options: [
            {
              flags: "--pretty",
              description: "Human-readable table output instead of JSON",
            },
          ],
        },
        {
          name: "select",
          description: "Select (activate) a browser tab by ID",
          options: [
            {
              flags: "--tab-id <id>",
              description: "Tab ID to select",
              required: true,
            },
          ],
        },
        {
          name: "new",
          description: "Open a new browser tab",
          options: [
            {
              flags: "--url <url>",
              description: "URL to navigate the new tab to",
            },
          ],
        },
        {
          name: "close",
          description: "Close a browser tab by ID",
          options: [
            {
              flags: "--tab-id <id>",
              description: "Tab ID to close",
              required: true,
            },
          ],
        },
      ],
    },
  ],
};
