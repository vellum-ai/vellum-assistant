/**
 * `assistant ui` CLI namespace.
 *
 * Subcommands:
 *   - `assistant ui request`  — Present an arbitrary interactive surface to
 *     the user and block until they respond. Input is a JSON payload
 *     describing the surface (via `--payload` or stdin).
 *   - `assistant ui confirm`  — Convenience wrapper that presents a yes/no
 *     confirmation prompt and exits 0 on confirm, 1 on deny/cancel/timeout.
 *
 * Both commands delegate to the daemon's `ui_request` IPC method, which
 * manages the surface lifecycle on the active conversation.
 */

import { readFileSync } from "node:fs";

import type { Command } from "commander";

import { cliIpcCall } from "../../ipc/cli-client.js";
import type {
  InteractiveUiAction,
  InteractiveUiResult,
} from "../../runtime/interactive-ui.js";
import { log } from "../logger.js";

// ── Constants ─────────────────────────────────────────────────────────

/**
 * Default request timeout in milliseconds (5 minutes). This is the time
 * the daemon will wait for the user to respond before the surface
 * auto-cancels with `status: "timed_out"`.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5m

/**
 * Extra buffer added to the IPC call timeout beyond the request timeout
 * so the IPC socket stays open long enough for the daemon to resolve the
 * surface and send the response.
 */
const IPC_TIMEOUT_BUFFER_MS = 10_000; // 10s

// ── Conversation ID resolution ────────────────────────────────────────

/**
 * Resolve the conversation ID by precedence:
 *   1. Explicit `--conversation-id` flag
 *   2. `__SKILL_CONTEXT_JSON` env var (set by skill sandbox runner)
 *   3. Fail with an actionable error
 */
function resolveConversationId(explicit?: string): string {
  if (explicit) return explicit;

  const contextJson = process.env.__SKILL_CONTEXT_JSON;
  if (contextJson) {
    try {
      const parsed = JSON.parse(contextJson);
      if (parsed.conversationId && typeof parsed.conversationId === "string") {
        return parsed.conversationId;
      }
    } catch {
      // Fall through to the error below.
    }
  }

  throw new Error(
    "No conversation ID available.\n" +
      "Provide --conversation-id explicitly (run 'assistant conversations list' to find it),\n" +
      "or run this command from a skill context where __SKILL_CONTEXT_JSON is set.",
  );
}

// ── Payload parsing ───────────────────────────────────────────────────

/**
 * Read a JSON payload from either the `--payload` flag or stdin.
 * Returns the parsed object. Throws on invalid input.
 */
function readPayload(payloadFlag?: string): Record<string, unknown> {
  if (payloadFlag) {
    try {
      const parsed = JSON.parse(payloadFlag);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error(
          "--payload must be a JSON object (not array or primitive).",
        );
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof SyntaxError) {
        throw new Error(
          `Invalid JSON in --payload: ${err.message}\n` +
            '  Example: --payload \'{"message":"Are you sure?"}\'',
        );
      }
      throw err;
    }
  }

  // Read from stdin
  if (process.stdin.isTTY) {
    throw new Error(
      "No payload provided. Use --payload <json> or pipe JSON into stdin.\n" +
        '  Example: echo \'{"message":"Are you sure?"}\' | assistant ui request',
    );
  }

  let raw: string;
  try {
    raw = readFileSync("/dev/stdin", "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read stdin: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!raw.trim()) {
    throw new Error(
      "Empty input on stdin. Provide a valid JSON object.\n" +
        '  Example: echo \'{"message":"Are you sure?"}\' | assistant ui request',
    );
  }

  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        "Stdin payload must be a JSON object (not array or primitive).",
      );
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(
        `Invalid JSON on stdin: ${err.message}\n` +
          '  Example: echo \'{"message":"Are you sure?"}\' | assistant ui request',
      );
    }
    throw err;
  }
}

// ── Action parsing ────────────────────────────────────────────────────

/** Valid variant values for action buttons. */
const VALID_VARIANTS = new Set(["primary", "danger", "secondary"]);

/**
 * Parse and validate the `--actions` JSON flag.
 *
 * Expected shape: an array of objects, each with:
 *   - `id`      (string, required, non-empty)
 *   - `label`   (string, required, non-empty)
 *   - `variant` (optional: "primary" | "danger" | "secondary")
 *
 * Returns the validated array, or throws with an actionable CLI error.
 */
function parseActions(raw: string): InteractiveUiAction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid JSON in --actions: ${err instanceof SyntaxError ? err.message : String(err)}\n` +
        "  --actions must be a JSON array of action objects.\n" +
        '  Example: --actions \'[{"id":"approve","label":"Approve"},{"id":"reject","label":"Reject","variant":"danger"}]\'',
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      "--actions must be a JSON array of action objects.\n" +
        '  Example: --actions \'[{"id":"approve","label":"Approve"}]\'',
    );
  }

  if (parsed.length === 0) {
    throw new Error(
      "--actions must contain at least one action.\n" +
        '  Example: --actions \'[{"id":"approve","label":"Approve"}]\'',
    );
  }

  const actions: InteractiveUiAction[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(
        `--actions[${i}]: each action must be a JSON object with "id" and "label" fields.\n` +
          '  Example: {"id":"approve","label":"Approve"}',
      );
    }

    const obj = item as Record<string, unknown>;

    if (typeof obj.id !== "string" || obj.id.length === 0) {
      throw new Error(
        `--actions[${i}]: "id" is required and must be a non-empty string.\n` +
          '  Example: {"id":"approve","label":"Approve"}',
      );
    }

    if (typeof obj.label !== "string" || obj.label.length === 0) {
      throw new Error(
        `--actions[${i}]: "label" is required and must be a non-empty string.\n` +
          '  Example: {"id":"approve","label":"Approve"}',
      );
    }

    const action: InteractiveUiAction = { id: obj.id, label: obj.label };

    if (obj.variant !== undefined) {
      if (typeof obj.variant !== "string" || !VALID_VARIANTS.has(obj.variant)) {
        throw new Error(
          `--actions[${i}]: "variant" must be one of "primary", "danger", or "secondary" (got ${JSON.stringify(obj.variant)}).\n` +
            '  Example: {"id":"delete","label":"Delete","variant":"danger"}',
        );
      }
      action.variant = obj.variant as InteractiveUiAction["variant"];
    }

    actions.push(action);
  }

  return actions;
}

// ── Strict integer parsing ────────────────────────────────────────────

/**
 * Parse a string as a strict positive integer. Rejects inputs like
 * `"1e3"`, `"30s"`, `"12.5"` that `parseInt` would silently truncate.
 * Returns the parsed integer or `NaN` on any non-pure-integer input.
 */
function parseStrictPositiveInt(value: string): number {
  if (!/^\d+$/.test(value)) return NaN;
  return Number(value);
}

// ── Registration ──────────────────────────────────────────────────────

export function registerUiCommand(program: Command): void {
  const ui = program
    .command("ui")
    .description("Present interactive UI surfaces to the user");

  ui.addHelpText(
    "after",
    `
Script-facing commands that present interactive surfaces (confirmations,
forms) to the user via the running assistant and block until the user
responds or the request times out.

The conversation ID is resolved automatically when running inside a skill
context (__SKILL_CONTEXT_JSON). Override with --conversation-id if needed.

Examples:
  $ echo '{"message":"Delete all logs?"}' | assistant ui request --json
  $ assistant ui confirm --title "Deploy to production?" --message "This will push to prod."
  $ assistant ui confirm --message "Are you sure?" --json`,
  );

  // ── ui request ───────────────────────────────────────────────────

  ui.command("request")
    .description(
      "Present an interactive surface and block until the user responds",
    )
    .option("--payload <json>", "JSON object describing the surface data")
    .option(
      "--surface-type <type>",
      'Surface type: "confirmation" or "form"',
      "confirmation",
    )
    .option("--title <title>", "Title displayed on the surface")
    .option(
      "--actions <json>",
      "JSON array of action objects defining custom buttons/options",
    )
    .option(
      "--conversation-id <id>",
      "Conversation ID — run 'assistant conversations list' to find it (auto-resolved from skill context if omitted)",
    )
    .option(
      "--timeout <ms>",
      "Request timeout in milliseconds",
      String(DEFAULT_REQUEST_TIMEOUT_MS),
    )
    .option("--json", "Output result as machine-readable JSON")
    .addHelpText(
      "after",
      `
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
    )
    .action(
      async (opts: {
        payload?: string;
        surfaceType?: string;
        title?: string;
        actions?: string;
        conversationId?: string;
        timeout?: string;
        json?: boolean;
      }) => {
        // Parse payload
        let data: Record<string, unknown>;
        try {
          data = readPayload(opts.payload);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: msg }) + "\n",
            );
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
          return;
        }

        // Resolve conversation ID
        let conversationId: string;
        try {
          conversationId = resolveConversationId(opts.conversationId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: msg }) + "\n",
            );
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
          return;
        }

        // Parse actions (if provided)
        let actions: InteractiveUiAction[] | undefined;
        if (opts.actions) {
          try {
            actions = parseActions(opts.actions);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (opts.json) {
              process.stdout.write(
                JSON.stringify({ ok: false, error: msg }) + "\n",
              );
            } else {
              log.error(msg);
            }
            process.exitCode = 1;
            return;
          }
        }

        // Parse timeout
        const rawTimeout = opts.timeout ?? String(DEFAULT_REQUEST_TIMEOUT_MS);
        const requestTimeoutMs = parseStrictPositiveInt(rawTimeout);
        if (isNaN(requestTimeoutMs) || requestTimeoutMs <= 0) {
          const msg = `Invalid --timeout value "${opts.timeout}". Must be a positive integer (milliseconds).`;
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: msg }) + "\n",
            );
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
          return;
        }

        // Build IPC params
        const ipcParams: Record<string, unknown> = {
          conversationId,
          surfaceType: opts.surfaceType ?? "confirmation",
          data,
          timeoutMs: requestTimeoutMs,
        };
        if (opts.title) {
          ipcParams.title = opts.title;
        }
        if (actions) {
          ipcParams.actions = actions;
        }

        // Call IPC with timeout budget = request timeout + buffer
        const ipcTimeoutMs = requestTimeoutMs + IPC_TIMEOUT_BUFFER_MS;
        const result = await cliIpcCall<InteractiveUiResult>(
          "ui_request",
          ipcParams,
          {
            timeoutMs: ipcTimeoutMs,
          },
        );

        if (!result.ok) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: result.error }) + "\n",
            );
          } else {
            log.error(`Error: ${result.error}`);
          }
          process.exitCode = 1;
          return;
        }

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, ...result.result }) + "\n",
          );
        } else {
          const r = result.result!;
          if (r.status === "submitted") {
            log.info(
              `User responded: ${r.actionId ?? "submitted"}${r.summary ? ` — ${r.summary}` : ""}`,
            );
          } else if (r.status === "timed_out") {
            log.info("Request timed out without a response.");
          } else {
            log.info("Request was cancelled.");
          }
        }
      },
    );

  // ── ui confirm ──────────────────────────────────────────────────

  ui.command("confirm")
    .description(
      "Present a yes/no confirmation prompt; exits 0 on confirm, 1 on deny/cancel/timeout",
    )
    .option("--title <title>", "Title displayed on the confirmation prompt")
    .option(
      "--message <message>",
      "Message body shown in the confirmation prompt",
    )
    .option(
      "--confirm-label <label>",
      'Label for the confirm button (default: "Confirm")',
      "Confirm",
    )
    .option(
      "--deny-label <label>",
      'Label for the deny button (default: "Deny")',
      "Deny",
    )
    .option(
      "--conversation-id <id>",
      "Conversation ID — run 'assistant conversations list' to find it (auto-resolved from skill context if omitted)",
    )
    .option(
      "--timeout <ms>",
      "Request timeout in milliseconds",
      String(DEFAULT_REQUEST_TIMEOUT_MS),
    )
    .option("--json", "Output result as machine-readable JSON")
    .addHelpText(
      "after",
      `
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
    )
    .action(
      async (opts: {
        title?: string;
        message?: string;
        confirmLabel?: string;
        denyLabel?: string;
        conversationId?: string;
        timeout?: string;
        json?: boolean;
      }) => {
        // Resolve conversation ID
        let conversationId: string;
        try {
          conversationId = resolveConversationId(opts.conversationId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: msg }) + "\n",
            );
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
          return;
        }

        // Parse timeout
        const rawTimeout = opts.timeout ?? String(DEFAULT_REQUEST_TIMEOUT_MS);
        const requestTimeoutMs = parseStrictPositiveInt(rawTimeout);
        if (isNaN(requestTimeoutMs) || requestTimeoutMs <= 0) {
          const msg = `Invalid --timeout value "${opts.timeout}". Must be a positive integer (milliseconds).`;
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: msg }) + "\n",
            );
          } else {
            log.error(msg);
          }
          process.exitCode = 1;
          return;
        }

        // Build confirmation surface data
        const confirmLabel = opts.confirmLabel ?? "Confirm";
        const denyLabel = opts.denyLabel ?? "Deny";
        const data: Record<string, unknown> = {};
        if (opts.message) data.message = opts.message;
        // Pass custom labels via data payload so the renderer reads them
        // from ConfirmationSurfaceData.confirmLabel / .cancelLabel.
        data.confirmLabel = confirmLabel;
        data.cancelLabel = denyLabel;

        // Build IPC params
        const ipcParams: Record<string, unknown> = {
          conversationId,
          surfaceType: "confirmation",
          data,
          actions: [
            {
              id: "confirm",
              label: confirmLabel,
              variant: "primary",
            },
            {
              id: "deny",
              label: denyLabel,
              variant: "secondary",
            },
          ],
          timeoutMs: requestTimeoutMs,
        };
        if (opts.title) {
          ipcParams.title = opts.title;
        }

        // Call IPC with timeout budget
        const ipcTimeoutMs = requestTimeoutMs + IPC_TIMEOUT_BUFFER_MS;
        const result = await cliIpcCall<InteractiveUiResult>(
          "ui_request",
          ipcParams,
          {
            timeoutMs: ipcTimeoutMs,
          },
        );

        if (!result.ok) {
          if (opts.json) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: result.error }) + "\n",
            );
          } else {
            log.error(`Error: ${result.error}`);
          }
          process.exitCode = 1;
          return;
        }

        const r = result.result!;
        const confirmed = r.status === "submitted" && r.actionId === "confirm";

        if (opts.json) {
          const jsonOut: Record<string, unknown> = {
            ok: true,
            confirmed,
            status: r.status,
            actionId: r.actionId,
            surfaceId: r.surfaceId,
          };
          if (r.decisionToken !== undefined) {
            jsonOut.decisionToken = r.decisionToken;
          }
          if (r.summary !== undefined) {
            jsonOut.summary = r.summary;
          }
          process.stdout.write(JSON.stringify(jsonOut) + "\n");
        } else {
          if (confirmed) {
            log.info("Confirmed.");
          } else if (r.status === "timed_out") {
            log.info("Confirmation timed out.");
          } else if (r.status === "cancelled") {
            log.info("Confirmation cancelled.");
          } else {
            log.info("Denied.");
          }
        }

        if (!confirmed) {
          process.exitCode = 1;
        }
      },
    );
}
