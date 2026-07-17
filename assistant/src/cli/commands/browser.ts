/**
 * `assistant browser` CLI namespace.
 *
 * One subcommand per browser operation, driven from the shared
 * browser operations contract ({@link BROWSER_OPERATION_META}).
 * Each subcommand maps CLI kebab-case flags into snake_case input
 * keys and calls `browser_execute` over the CLI IPC socket.
 */

import { writeFileSync } from "node:fs";

import type { Command } from "commander";

// operation-meta is an execution-free data leaf (no Playwright imports),
// consumed synchronously while building the `browser` subcommand tree — the
// program is assembled by the sync `buildCliProgramTree()`, so this can't be a
// lazy `import()`. Kept out of the heavier `browser/operations` barrel on
// purpose.
// eslint-disable-next-line cli/no-daemon-internals
import { BROWSER_OPERATION_META } from "../../browser/operation-meta.js";
import type {
  BrowserOperationMeta,
  OperationField,
} from "../../browser/types.js";
import { cliIpcCall } from "../../ipc/cli-client.js";
import { applyCommandHelp, subcommand } from "../lib/cli-command-help.js";
import { registerCommand } from "../lib/register-command.js";
import { log } from "../logger.js";
import { browserHelp, toKebab } from "./browser.help.js";

// ── Naming helpers ───────────────────────────────────────────────────

/**
 * Convert a kebab-case option key back to snake_case for the IPC
 * input object (e.g. `allowPrivateNetwork` -> `allow_private_network`).
 *
 * Commander camelCases option names, so we convert from camelCase
 * to snake_case.
 */
function camelToSnake(camel: string): string {
  return camel.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

/**
 * Resolve conversation ID from CLI execution context.
 *
 * Precedence:
 *   1. `__SKILL_CONTEXT_JSON.conversationId`
 *   2. `__CONVERSATION_ID`
 *
 * Returns undefined when neither source is available.
 */
function resolveContextConversationId(): string | undefined {
  const contextJson = process.env.__SKILL_CONTEXT_JSON;
  if (contextJson) {
    try {
      const parsed = JSON.parse(contextJson) as { conversationId?: unknown };
      if (
        typeof parsed.conversationId === "string" &&
        parsed.conversationId.length > 0
      ) {
        return parsed.conversationId;
      }
    } catch {
      // Ignore malformed skill context and fall through.
    }
  }

  const envConversationId = process.env.__CONVERSATION_ID;
  if (envConversationId && envConversationId.length > 0) {
    return envConversationId;
  }

  return undefined;
}

/**
 * Parse a CLI option value according to its field type.
 */
function parseFieldValue(
  value: unknown,
  field: OperationField,
): string | number | boolean {
  if (field.type === "boolean") {
    return Boolean(value);
  }
  if (field.type === "number") {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid number for --${toKebab(field.name)}: ${value}`);
    }
    return num;
  }
  return String(value);
}

// ── IPC response shape ───────────────────────────────────────────────

interface BrowserExecuteResult {
  content: string;
  isError: boolean;
  screenshots?: Array<{ mediaType: string; data: string }>;
}

// ── Operation action wiring ──────────────────────────────────────────

/**
 * Attach the `browser_execute` action for a single browser operation to its
 * (already help-declared) subcommand.
 */
function attachOperationAction(
  browser: Command,
  meta: BrowserOperationMeta,
): void {
  const subcmd = subcommand(browser, toKebab(meta.operation));

  subcmd.action(async (opts: Record<string, unknown>) => {
    const parentOpts = browser.opts() as {
      session?: string;
      json?: boolean;
      browserMode?: string;
      targetClientId?: string;
    };
    const sessionId = parentOpts.session ?? "default";
    const jsonMode = parentOpts.json ?? false;
    const conversationId = resolveContextConversationId();

    // Map Commander camelCase options back to snake_case input keys,
    // filtering out parent-level options (session, json, browserMode,
    // targetClientId) and screenshot ergonomics (output).
    const input: Record<string, unknown> = {};
    const excludeKeys = new Set([
      "session",
      "json",
      "output",
      "browserMode",
      "targetClientId",
    ]);

    // Inject parent-level flags into the operation input.
    if (parentOpts.browserMode) {
      input.browser_mode = parentOpts.browserMode;
    }
    if (parentOpts.targetClientId) {
      input.target_client_id = parentOpts.targetClientId;
    }

    for (const [key, value] of Object.entries(opts)) {
      if (excludeKeys.has(key)) {
        continue;
      }
      if (value === undefined) {
        continue;
      }

      const snakeKey = camelToSnake(key);
      // Find the matching field for type coercion
      const field = meta.fields.find((f) => f.name === snakeKey);
      if (field) {
        input[snakeKey] = parseFieldValue(value, field);
      } else {
        input[snakeKey] = value;
      }
    }

    // Browser operations can be long-running (page loads, auth
    // challenges, downloads up to 120s, etc.), so use a generous
    // IPC timeout that exceeds any server-side operation timeout.
    const ipcResult = await cliIpcCall<BrowserExecuteResult>(
      "browser_execute",
      {
        body: {
          operation: meta.operation,
          input,
          sessionId,
          ...(conversationId ? { conversationId } : {}),
        },
      },
      { timeoutMs: 180_000 },
    );

    if (!ipcResult.ok) {
      if (jsonMode) {
        process.stdout.write(
          JSON.stringify({ ok: false, error: ipcResult.error }) + "\n",
        );
      } else {
        log.error(`Error: ${ipcResult.error}`);
      }
      process.exitCode = 1;
      return;
    }

    const result = ipcResult.result!;

    if (result.isError) {
      if (jsonMode) {
        process.stdout.write(
          JSON.stringify({ ok: false, error: result.content }) + "\n",
        );
      } else {
        log.error(result.content);
      }
      process.exitCode = 1;
      return;
    }

    // Handle screenshot --output: write JPEG to disk
    if (
      meta.operation === "screenshot" &&
      opts.output &&
      result.screenshots?.length
    ) {
      const screenshot = result.screenshots[0];
      const buffer = Buffer.from(screenshot.data, "base64");
      try {
        writeFileSync(String(opts.output), buffer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (jsonMode) {
          process.stdout.write(
            JSON.stringify({
              ok: false,
              error: `Failed to write screenshot to ${opts.output}: ${msg}`,
            }) + "\n",
          );
        } else {
          log.error(`Failed to write screenshot to ${opts.output}: ${msg}`);
        }
        process.exitCode = 1;
        return;
      }
      if (!jsonMode) {
        log.info(`Screenshot saved to ${opts.output}`);
      }
    }

    if (jsonMode) {
      const payload: Record<string, unknown> = {
        ok: true,
        content: result.content,
      };
      // Include base64 screenshot data in JSON output
      if (result.screenshots?.length) {
        payload.screenshots = result.screenshots;
      }
      process.stdout.write(JSON.stringify(payload) + "\n");
    } else if (meta.operation === "status" && result.content) {
      formatBrowserStatus(result.content);
    } else {
      if (result.content) {
        log.info(result.content);
      }
    }
  });
}

// ── Status formatter ─────────────────────────────────────────────────

interface StatusModeEntry {
  mode: string;
  available: boolean;
  autoCandidate: boolean;
  summary: string;
}

interface StatusPayload {
  requestedMode: string;
  recommendedMode: string | null;
  stickyConversationMode: string | null;
  modes: StatusModeEntry[];
}

function formatBrowserStatus(content: string): void {
  let data: StatusPayload;
  try {
    data = JSON.parse(content);
  } catch {
    log.info(content);
    return;
  }

  log.info(`Requested mode: ${data.requestedMode}`);
  if (data.recommendedMode) {
    log.info(`Recommended:    ${data.recommendedMode}`);
  }
  if (data.stickyConversationMode) {
    log.info(`Sticky mode:    ${data.stickyConversationMode}`);
  }
  log.info("");

  const modes = data.modes ?? [];
  for (const mode of modes) {
    const icon = mode.available ? "✓" : "✗";
    const auto = mode.autoCandidate ? " (auto-candidate)" : "";
    log.info(`  ${icon} ${mode.mode}${auto}`);
    log.info(`    ${mode.summary}`);
    log.info("");
  }
}

// ── Registration ─────────────────────────────────────────────────────

export function registerBrowserCommand(program: Command): void {
  registerCommand(program, {
    name: browserHelp.name,
    transport: "ipc",
    description: browserHelp.description,
    build: (browser) => {
      applyCommandHelp(browser, browserHelp);

      // Attach one action per browser operation
      for (const meta of BROWSER_OPERATION_META) {
        attachOperationAction(browser, meta);
      }

      // -- tabs subcommand group
      const tabs = subcommand(browser, "tabs");

      subcommand(tabs, "list").action(async (opts: { pretty?: boolean }) => {
        const parentOpts = browser.opts() as {
          session?: string;
          json?: boolean;
          targetClientId?: string;
        };
        const sessionId = parentOpts.session ?? "default";
        const jsonMode = parentOpts.json ?? false;
        const conversationId = resolveContextConversationId();
        const targetClientId = parentOpts.targetClientId;

        const ipcResult = await cliIpcCall<{
          ok: boolean;
          tabs?: Array<{
            tabId?: number;
            windowId?: number;
            url?: string;
            title?: string;
            active: boolean;
            pinned: boolean;
          }>;
        }>(
          "browser_tabs",
          {
            body: {
              command: "list",
              sessionId,
              ...(conversationId ? { conversationId } : {}),
              ...(targetClientId ? { targetClientId } : {}),
            },
          },
          { timeoutMs: 30_000 },
        );

        if (!ipcResult.ok) {
          if (jsonMode) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: ipcResult.error }) + "\n",
            );
          } else {
            log.error(`Error: ${ipcResult.error}`);
          }
          process.exitCode = 1;
          return;
        }

        const tabList = ipcResult.result?.tabs ?? [];

        if (jsonMode || !opts.pretty) {
          process.stdout.write(JSON.stringify(tabList) + "\n");
        } else {
          if (tabList.length === 0) {
            log.info("No tabs found.");
            return;
          }
          log.info(
            `${"ID".padEnd(8)} ${"WIN".padEnd(5)} ${"ACT".padEnd(4)} ${"PIN".padEnd(4)} URL/Title`,
          );
          log.info("-".repeat(80));
          for (const tab of tabList) {
            const id = String(tab.tabId ?? "?").padEnd(8);
            const win = String(tab.windowId ?? "?").padEnd(5);
            const act = (tab.active ? "yes" : "no").padEnd(4);
            const pin = (tab.pinned ? "yes" : "no").padEnd(4);
            const label = tab.url ?? tab.title ?? "(untitled)";
            log.info(`${id} ${win} ${act} ${pin} ${label}`);
          }
        }
      });

      subcommand(tabs, "select").action(async (opts: { tabId: string }) => {
        const parentOpts = browser.opts() as {
          session?: string;
          json?: boolean;
          targetClientId?: string;
        };
        const sessionId = parentOpts.session ?? "default";
        const jsonMode = parentOpts.json ?? false;
        const conversationId = resolveContextConversationId();
        const targetClientId = parentOpts.targetClientId;
        const tabId = Number(opts.tabId);

        const ipcResult = await cliIpcCall<{ ok: boolean; tab?: unknown }>(
          "browser_tabs",
          {
            body: {
              command: "select",
              sessionId,
              tabId,
              ...(conversationId ? { conversationId } : {}),
              ...(targetClientId ? { targetClientId } : {}),
            },
          },
          { timeoutMs: 30_000 },
        );

        if (!ipcResult.ok) {
          if (jsonMode) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: ipcResult.error }) + "\n",
            );
          } else {
            log.error(`Error: ${ipcResult.error}`);
          }
          process.exitCode = 1;
          return;
        }

        if (jsonMode) {
          process.stdout.write(
            JSON.stringify({ ok: true, tab: ipcResult.result?.tab }) + "\n",
          );
        } else {
          log.info(`Selected tab ${tabId}`);
        }
      });

      subcommand(tabs, "new").action(async (opts: { url?: string }) => {
        const parentOpts = browser.opts() as {
          session?: string;
          json?: boolean;
          targetClientId?: string;
        };
        const sessionId = parentOpts.session ?? "default";
        const jsonMode = parentOpts.json ?? false;
        const conversationId = resolveContextConversationId();
        const targetClientId = parentOpts.targetClientId;

        const ipcResult = await cliIpcCall<{
          ok: boolean;
          tabId?: string;
          clientId?: string;
        }>(
          "browser_tabs",
          {
            body: {
              command: "new",
              sessionId,
              ...(opts.url ? { url: opts.url } : {}),
              ...(conversationId ? { conversationId } : {}),
              ...(targetClientId ? { targetClientId } : {}),
            },
          },
          { timeoutMs: 30_000 },
        );

        if (!ipcResult.ok) {
          if (jsonMode) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: ipcResult.error }) + "\n",
            );
          } else {
            log.error(`Error: ${ipcResult.error}`);
          }
          process.exitCode = 1;
          return;
        }

        if (jsonMode) {
          process.stdout.write(
            JSON.stringify({
              ok: true,
              tabId: ipcResult.result?.tabId,
              clientId: ipcResult.result?.clientId,
            }) + "\n",
          );
        } else {
          log.info(
            `Opened new tab${ipcResult.result?.tabId ? ` (ID: ${ipcResult.result.tabId})` : ""}`,
          );
        }
      });

      subcommand(tabs, "close").action(async (opts: { tabId: string }) => {
        const parentOpts = browser.opts() as {
          session?: string;
          json?: boolean;
          targetClientId?: string;
        };
        const sessionId = parentOpts.session ?? "default";
        const jsonMode = parentOpts.json ?? false;
        const conversationId = resolveContextConversationId();
        const targetClientId = parentOpts.targetClientId;
        const tabId = Number(opts.tabId);

        const ipcResult = await cliIpcCall<{
          ok: boolean;
          closed?: boolean;
          tabId?: number;
        }>(
          "browser_tabs",
          {
            body: {
              command: "close",
              sessionId,
              tabId,
              ...(conversationId ? { conversationId } : {}),
              ...(targetClientId ? { targetClientId } : {}),
            },
          },
          { timeoutMs: 30_000 },
        );

        if (!ipcResult.ok) {
          if (jsonMode) {
            process.stdout.write(
              JSON.stringify({ ok: false, error: ipcResult.error }) + "\n",
            );
          } else {
            log.error(`Error: ${ipcResult.error}`);
          }
          process.exitCode = 1;
          return;
        }

        if (jsonMode) {
          process.stdout.write(
            JSON.stringify({
              ok: true,
              closed: ipcResult.result?.closed,
              tabId,
            }) + "\n",
          );
        } else {
          log.info(`Closed tab ${tabId}`);
        }
      });
    },
  });
}
