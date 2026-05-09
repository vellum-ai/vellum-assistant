/**
 * Memory v2 — `memory_v2_sweep` job handler.
 *
 * The sweep is the auto-extraction analog of v1's `graph_extract`: idle-
 * debounced, prompted with the current `memory/buffer.md` so it dedupes
 * against entries `remember()` already wrote, and asked to surface anything
 * the assistant should have remembered but missed. Each returned entry is
 * appended to `memory/buffer.md` and `memory/archive/<today>.md` using the
 * exact same write path as `remember()` so consolidation can't tell which
 * entries came from the model and which came from the tool call.
 *
 * Lifecycle integration: scheduled by PR 24's hook into the existing
 * extraction-trigger path. Until then this handler is invoked only by
 * `memory_v2_sweep` rows enqueued explicitly (tests, future CLI).
 *
 * Skipped entirely when `config.memory.v2.enabled` is false, or when
 * `config.memory.v2.sweep_enabled` is false — keeps the sweep dormant in
 * v1-only workspaces and in v2 workspaces that haven't opted in, even if a
 * stale row sits in the queue when v2 is disabled.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { and, desc, eq, gt, notInArray } from "drizzle-orm";
import { z } from "zod";

import type { AssistantConfig } from "../../config/types.js";
import { getAssistantName } from "../../daemon/identity-helpers.js";
import {
  extractToolUse,
  getConfiguredProvider,
  userMessage,
} from "../../providers/provider-send-message.js";
import type { ToolDefinition } from "../../providers/types.js";
import { getLogger } from "../../util/logger.js";
import { getWorkspaceDir } from "../../util/platform.js";
import { getDb } from "../db-connection.js";
import {
  appendBufferAndArchive,
  formatRememberEntry,
} from "../graph/tool-handlers.js";
import type { MemoryJob } from "../jobs-store.js";
import { stringifyMessageContent } from "../message-content.js";
import { conversations, messages } from "../schema.js";
import { renderSweepPrompt } from "./prompts/sweep.js";

const log = getLogger("memory-v2-sweep");

/** Window of conversation history the sweep inspects on each run. */
const RECENT_MESSAGES_WINDOW_MS = 30 * 60 * 1000;

/**
 * Cap on the message text we hand the model. Recent-messages text is the
 * single-largest input — clamping keeps the request under typical context
 * windows without having to compute precise token counts.
 */
const MAX_RECENT_TEXT_CHARS = 32_000;

/**
 * Cap on the buffer text we hand the model. The buffer can grow large in
 * busy workspaces; the model only needs enough to dedupe, not the entire
 * archive.
 */
const MAX_BUFFER_CHARS = 16_000;

// Tool-call schema. The JSON schema is what the provider sees; the Zod
// schema below validates the model's reply at runtime since the SDK
// returns the tool input as `unknown`. The two must stay in sync.
const SWEEP_TOOL_NAME = "emit_remember_entries";

const SWEEP_TOOL: ToolDefinition = {
  name: SWEEP_TOOL_NAME,
  description:
    "Emit zero or more remember()-style entries the assistant should commit to long-term memory.",
  input_schema: {
    type: "object",
    properties: {
      entries: {
        type: "array",
        description:
          "Each entry is a single line in the assistant's first-person voice (e.g. 'Alice prefers VS Code over Vim').",
        items: { type: "string" },
      },
    },
    required: ["entries"],
  },
};

const SweepResultSchema = z.object({
  entries: z.array(z.string()),
});

/**
 * Job handler. Reads recent messages + buffer, asks the configured provider
 * for additional remember-able entries, and appends each entry to
 * `memory/buffer.md` + `memory/archive/<today>.md` via the same helper
 * `remember()` uses.
 *
 * Returns the number of entries written so callers (and tests) can assert
 * progress without inspecting the filesystem.
 */
export async function memoryV2SweepJob(
  _job: MemoryJob,
  config: AssistantConfig,
): Promise<number> {
  if (!config.memory?.v2?.enabled) {
    log.debug("memory.v2.enabled is false; sweep skipped");
    return 0;
  }

  if (!config.memory.v2.sweep_enabled) {
    log.debug("memory.v2.sweep_enabled is false; sweep skipped");
    return 0;
  }

  const workspaceDir = getWorkspaceDir();
  const memoryDir = join(workspaceDir, "memory");
  const recentText = loadRecentMessagesText(Date.now());
  if (!recentText) {
    log.debug("No recent messages in window; sweep skipped");
    return 0;
  }

  const existingBuffer = readBufferText(memoryDir);

  const provider = await getConfiguredProvider("memoryV2Sweep");
  if (!provider) {
    log.warn("memoryV2Sweep provider unavailable; sweep skipped");
    return 0;
  }

  const systemPrompt = renderSweepPrompt({
    assistantName: getAssistantName(),
    userName: resolveUserName(workspaceDir),
  });
  const userText =
    `## existingBuffer\n\n${existingBuffer || "(empty)"}\n\n` +
    `## recentMessages\n\n${recentText}`;

  const response = await provider.sendMessage(
    [userMessage(userText)],
    [SWEEP_TOOL],
    systemPrompt,
    {
      config: {
        callSite: "memoryV2Sweep" as const,
        tool_choice: { type: "tool" as const, name: SWEEP_TOOL_NAME },
      },
    },
  );

  const toolBlock = extractToolUse(response);
  if (!toolBlock || toolBlock.name !== SWEEP_TOOL_NAME) {
    log.debug("Sweep model returned no tool_use block");
    return 0;
  }
  const parsed = SweepResultSchema.safeParse(toolBlock.input);
  if (!parsed.success) {
    log.warn(
      { error: parsed.error.message },
      "Sweep tool input did not match schema",
    );
    return 0;
  }

  const written = appendEntries(memoryDir, parsed.data.entries);
  if (written > 0) {
    log.info({ written }, "Memory v2 sweep wrote new buffer entries");
  }
  return written;
}

/**
 * Append each non-empty entry to `memory/buffer.md` + today's archive,
 * using the same format `remember()` produces. Returns the count of entries
 * actually written (empties and whitespace-only strings are skipped so the
 * model can't pad the response).
 */
function appendEntries(memoryDir: string, entries: string[]): number {
  let written = 0;
  for (const raw of entries) {
    const content = typeof raw === "string" ? raw.trim() : "";
    if (!content) continue;
    const now = new Date();
    const entry = formatRememberEntry(content, now);
    appendBufferAndArchive({ rootDir: memoryDir, entry, now });
    written += 1;
  }
  return written;
}

/**
 * Read `memory/buffer.md` and return its contents, capped at
 * `MAX_BUFFER_CHARS`. Missing file → empty string. The cap keeps the dedup
 * signal manageable; we slice from the *end* of the file so the most recent
 * entries always survive.
 */
function readBufferText(memoryDir: string): string {
  let text: string;
  try {
    text = readFileSync(join(memoryDir, "buffer.md"), "utf-8");
  } catch {
    return "";
  }
  if (text.length <= MAX_BUFFER_CHARS) return text;
  return text.slice(text.length - MAX_BUFFER_CHARS);
}

/**
 * Pull recent messages from every conversation in the window, formatted
 * as `[role]: content` lines so the model can follow the back-and-forth.
 *
 * Bounded by `MAX_RECENT_TEXT_CHARS` — when the window is busier than the
 * cap, the *oldest* messages are dropped (truncate-from-front) so the model
 * always sees the latest context.
 */
function loadRecentMessagesText(nowMs: number): string {
  const cutoff = nowMs - RECENT_MESSAGES_WINDOW_MS;
  const db = getDb();
  // Pull newest-first then reverse for chronological output. Bounding the
  // initial limit (1000) defends against pathological busy windows where a
  // naive scan would touch every recent message. Joining conversations and
  // excluding background/scheduled types keeps automation chatter
  // (heartbeats, filing, update bulletins, scheduled jobs) out of buffer.md.
  const rows = db
    .select({
      role: messages.role,
      content: messages.content,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .where(
      and(
        gt(messages.createdAt, cutoff),
        notInArray(conversations.conversationType, ["background", "scheduled"]),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1000)
    .all();
  if (rows.length === 0) return "";

  const lines: string[] = [];
  for (const row of rows) {
    const text = stringifyMessageContent(row.content);
    if (!text) continue;
    lines.push(`[${row.role}]: ${text}`);
  }
  if (lines.length === 0) return "";

  // Reverse so the oldest message lands first — natural reading order.
  lines.reverse();
  let joined = lines.join("\n\n");
  if (joined.length > MAX_RECENT_TEXT_CHARS) {
    joined = joined.slice(joined.length - MAX_RECENT_TEXT_CHARS);
  }
  return joined;
}

/**
 * Read the guardian's display name from `users/default.md`. We look for the
 * markdown-bold "Name" label (matching the IDENTITY.md convention) and fall
 * back to `null` on any miss; the prompt template substitutes a generic
 * label.
 */
function resolveUserName(workspaceDir: string): string | null {
  try {
    const content = readFileSync(
      join(workspaceDir, "users", "default.md"),
      "utf-8",
    );
    const match = content.match(/\*\*Name:\*\*\s*(.+)/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}
