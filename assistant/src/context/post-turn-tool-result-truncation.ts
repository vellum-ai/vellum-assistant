import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ContentBlock,
  Message,
  ToolResultContent,
  ToolUseContent,
} from "../providers/types.js";
import {
  parseExternalContentEnvelope,
  wrapUntrustedContent,
} from "../security/untrusted-content.js";
import { safeStringSlice } from "../util/unicode.js";

/** Minimum content length (chars) before a tool result is eligible for truncation. ~6250 tokens at 4 chars/token. */
export const THRESHOLD_CHARS = 25_000;

/** Target size (chars) for the truncated stub. ~300 tokens at 4 chars/token. */
export const TARGET_CHARS = 1_200;

/** Subdirectory name under the conversation directory for saved full results. */
export const TOOL_RESULT_DIR = ".tool-results";

/** Marker used to detect already-truncated results (idempotency guard). */
export const TRUNCATION_MARKER = "\u2014 full result:";

/**
 * Tools whose results carry durable operating instructions the model relies on
 * across later turns rather than one-off data it only needs in the moment.
 * Their results must never be middle-truncated: paging out the middle silently
 * strips the workflow (e.g. a `skill_load` body losing its "## Available Tools"
 * section), leaving the model to fall back to generic priors. Skill bodies are
 * bounded and authored to live in context, so exempting them is safe.
 */
export const TRUNCATION_EXEMPT_TOOLS = new Set<string>(["skill_load"]);

/**
 * File-read tools that can page spooled `.tool-results/` content back into
 * context. `file_read` reads inside the workspace; `host_file_read` reads
 * anywhere on the host. A new file-read tool belongs here so
 * {@link isSpooledToolResultRead} recognizes it.
 */
export const FILE_READ_TOOL_NAMES = new Set<string>([
  "file_read",
  "host_file_read",
]);

/**
 * Whether a tool call is a file read aimed at a spooled `.tool-results/` file.
 *
 * Such a read is the model paging content back in, so both passes treat it
 * specially: the result-time spool pass leaves it alone (re-stubbing it would
 * write a fresh copy and hand back another stub, putting the content out of
 * reach for good), and {@link derefToolResultReReads} collapses it at turn end
 * (its prefix and suffix are already in context above). A file read aimed
 * anywhere else is ordinary tool output and gets no such treatment.
 */
export function isSpooledToolResultRead(
  toolName: string | undefined,
  input: Record<string, unknown> | undefined,
): boolean {
  if (toolName === undefined || !FILE_READ_TOOL_NAMES.has(toolName)) {
    return false;
  }
  const filePath = input?.path ?? input?.file_path;
  if (typeof filePath !== "string") {
    return false;
  }
  // The path in the stub comes from `join`, so it is backslash-separated on
  // Windows. Compare on a normalized form: a missed match would let the spool
  // pass stub this read and put the saved content permanently out of reach.
  return filePath.replace(/\\/g, "/").includes(`/${TOOL_RESULT_DIR}/`);
}

/**
 * Build a map of tool_use_id -> originating tool name by walking the tool_use
 * blocks in assistant messages. A tool_result only carries `tool_use_id`, so
 * this is the only way to recover which tool produced a given result.
 */
function buildToolNameById(messages: Message[]): Map<string, string> {
  const byId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") {
      continue;
    }
    for (const block of msg.content) {
      if (block.type !== "tool_use") {
        continue;
      }
      const tu = block as ToolUseContent;
      byId.set(tu.id, tu.name);
    }
  }
  return byId;
}

/**
 * Shared eligibility rules for replacing an oversized tool result with the
 * on-disk stub: string content over the size threshold, not an error result,
 * not from an exempt tool (durable instructions like skill bodies), and not
 * already truncated (idempotency marker). Used by both the post-turn pass and
 * the result-time spool pass so the two converge on the same results.
 */
export function isTruncationEligible(
  tr: ToolResultContent,
  toolName: string | undefined,
): boolean {
  if (typeof tr.content !== "string") {
    return false;
  }
  if (tr.content.length <= THRESHOLD_CHARS) {
    return false;
  }
  if (tr.is_error) {
    return false;
  }
  if (toolName !== undefined && TRUNCATION_EXEMPT_TOOLS.has(toolName)) {
    return false;
  }
  if (tr.content.includes(TRUNCATION_MARKER)) {
    return false;
  }
  return true;
}

/**
 * Deterministic file path for a tool result's full content on disk.
 * Uses the first 12 hex chars of the SHA-256 of the tool_use_id.
 */
export function getToolResultFilePath(
  conversationDir: string,
  toolUseId: string,
): string {
  const hash = createHash("sha256")
    .update(toolUseId)
    .digest("hex")
    .slice(0, 12);
  return join(conversationDir, TOOL_RESULT_DIR, `${hash}.txt`);
}

const EXTERNAL_CONTENT_TAG = /<(\/?)external_content\b[^\n>]*>/g;
const EXTERNAL_CONTENT_CLOSE_TAG = "</external_content>";
const EXTERNAL_CONTENT_OPEN_TAG = '<external_content source="tool_result">';

/**
 * Whether `chunk` ends inside an envelope, and whether it starts inside
 * one — determined by walking its fence tags in order rather than
 * comparing totals, so a stray tag on one side cannot mask one on the
 * other.
 *
 * Fenced content never contains a literal tag of either form
 * (`escapeContentBoundaries` escapes both), so every tag seen here is a
 * real wrapper.
 */
function scanEnvelopeBoundaries(chunk: string): {
  endsOpen: boolean;
  startsClosed: boolean;
} {
  let depth = 0;
  let startsClosed = false;
  for (const match of chunk.matchAll(EXTERNAL_CONTENT_TAG)) {
    if (match[1] === "/") {
      if (depth === 0) {
        startsClosed = true;
      } else {
        depth -= 1;
      }
    } else {
      depth += 1;
    }
  }
  return { endsOpen: depth > 0, startsClosed };
}

/**
 * Close a fence the prefix cut left hanging open.
 *
 * A mixed result (tool-owned lines around one or more embedded
 * `<external_content>` blocks) can be cut mid-envelope. Without repair
 * the marker that follows would read as being inside the fence — the
 * exact placement the model is told to ignore.
 */
function closeDanglingEnvelope(chunk: string): string {
  return scanEnvelopeBoundaries(chunk).endsOpen
    ? `${chunk}\n${EXTERNAL_CONTENT_CLOSE_TAG}`
    : chunk;
}

/**
 * Open a fence the suffix cut left hanging closed, so the marker that
 * precedes it does not fall inside the resulting envelope.
 */
function openDanglingEnvelope(chunk: string): string {
  return scanEnvelopeBoundaries(chunk).startsClosed
    ? `${EXTERNAL_CONTENT_OPEN_TAG}\n${chunk}`
    : chunk;
}

/**
 * Head/tail stub of `original` with the recovery marker spliced in
 * between, keeping the marker outside any `<external_content>` fence the
 * cut passed through.
 */
function spliceWithMarker(original: string, marker: string): string {
  const half = Math.floor(TARGET_CHARS / 2);
  const prefix = closeDanglingEnvelope(safeStringSlice(original, 0, half));
  const suffix = openDanglingEnvelope(
    safeStringSlice(original, original.length - half, original.length),
  );
  return `${prefix}\n\n...(${marker})\n\n${suffix}`;
}

/** `(N tokens omitted — full result: <path> — use file_read to view)` body. */
function recoveryMarker(omittedChars: number, filePath: string): string {
  const estimatedTokens = Math.round(omittedChars / 4);
  return `${estimatedTokens} tokens omitted ${TRUNCATION_MARKER} ${filePath} — use file_read to view`;
}

/**
 * Build the truncated stub that replaces a large tool result in context.
 * Preserves the first and last halves of TARGET_CHARS, with a middle marker
 * indicating how many tokens were omitted, where to find the full result, and
 * how to page it back in — the marker is the model's only signal that the
 * omitted content is recoverable at all.
 *
 * The marker is the daemon's own instruction, and the model is told never to
 * act on instructions inside an `<external_content>` fence — placed in there,
 * the one signal that the omitted content is recoverable becomes a signal it
 * must ignore. So fenced results (web fetch, browser page text, and anything
 * else fenced per `security/AGENTS.md`) get the marker outside the fence:
 *
 * - A result that is entirely one envelope has its fenced data truncated and
 *   the marker appended after the closing tag.
 * - A mixed result (tool-owned lines around embedded envelopes) is spliced as
 *   usual, with any fence the cut passed through repaired so the marker still
 *   lands outside it.
 */
export function buildTruncatedContent(
  original: string,
  filePath: string,
): string {
  const envelope = parseExternalContentEnvelope(original);
  if (envelope) {
    // The in-fence marker stays purely descriptive: nothing inside the
    // fence should read as an instruction. The recoverable-content
    // signal goes below, in the daemon's own voice.
    const inner = spliceWithMarker(envelope.content, "content omitted");
    const refenced = wrapUntrustedContent(inner, {
      source: envelope.source,
      ...(envelope.origin === undefined
        ? {}
        : { sourceDetail: envelope.origin }),
      maxChars: Number.MAX_SAFE_INTEGER,
    });
    const omittedChars = Math.max(0, envelope.content.length - TARGET_CHARS);
    return `${refenced}\n\n(${recoveryMarker(omittedChars, filePath)})`;
  }

  return spliceWithMarker(
    original,
    recoveryMarker(original.length - TARGET_CHARS, filePath),
  );
}

/**
 * Walk all messages and truncate tool results that exceed `THRESHOLD_CHARS`.
 *
 * For each eligible result:
 * - The full content is persisted to a deterministic file path on disk.
 * - The in-context content is replaced with a prefix/suffix stub.
 *
 * Results are skipped unless {@link isTruncationEligible} allows them.
 *
 * Returns a shallow-copied messages array (only modified messages are cloned)
 * and the count of results that were truncated.
 */
export function postTurnTruncateToolResults(
  messages: Message[],
  options: { conversationDir: string },
): { messages: Message[]; truncatedCount: number } {
  let truncatedCount = 0;

  const toolNameById = buildToolNameById(messages);

  const mapped = messages.map((msg) => {
    let changed = false;
    const nextContent: ContentBlock[] = msg.content.map((block) => {
      if (block.type !== "tool_result") {
        return block;
      }
      const tr = block as ToolResultContent;

      if (!isTruncationEligible(tr, toolNameById.get(tr.tool_use_id))) {
        return block;
      }

      const filePath = getToolResultFilePath(
        options.conversationDir,
        tr.tool_use_id,
      );

      // Persist full content to disk.
      mkdirSync(join(options.conversationDir, TOOL_RESULT_DIR), {
        recursive: true,
      });
      writeFileSync(filePath, tr.content, "utf-8");

      changed = true;
      truncatedCount++;
      return {
        ...tr,
        content: buildTruncatedContent(tr.content, filePath),
      } as ContentBlock;
    });

    return changed ? { ...msg, content: nextContent } : msg;
  });

  return { messages: truncatedCount > 0 ? mapped : messages, truncatedCount };
}

/** Stub that replaces a re-read of a saved tool result to avoid context duplication. */
export const REREAD_STUB =
  "(Re-read of saved tool result — original context is preserved above)";

/**
 * Deduplicate re-reads of saved tool results.
 *
 * When `postTurnTruncateToolResults` truncates a large result, it saves the full
 * content to a `.tool-results/` file. If the model later calls `file_read` or
 * `host_file_read` on that saved file, the result is a second copy of content
 * whose truncated prefix/suffix is already in context. This function detects
 * those re-reads and replaces their tool_result content with a short stub to
 * avoid duplication.
 */
export function derefToolResultReReads(messages: Message[]): {
  messages: Message[];
  dereferencedCount: number;
} {
  // Build a set of tool_use_ids that are file-read calls (file_read or
  // host_file_read) targeting .tool-results/ paths.
  const reReadToolUseIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "assistant") {
      continue;
    }
    for (const block of msg.content) {
      if (block.type !== "tool_use") {
        continue;
      }
      const tu = block as ToolUseContent;
      if (isSpooledToolResultRead(tu.name, tu.input)) {
        reReadToolUseIds.add(tu.id);
      }
    }
  }

  if (reReadToolUseIds.size === 0) {
    return { messages, dereferencedCount: 0 };
  }

  let dereferencedCount = 0;

  const mapped = messages.map((msg) => {
    if (msg.role !== "user") {
      return msg;
    }

    let changed = false;
    const nextContent: ContentBlock[] = msg.content.map((block) => {
      if (block.type !== "tool_result") {
        return block;
      }
      const tr = block as ToolResultContent;
      if (!reReadToolUseIds.has(tr.tool_use_id)) {
        return block;
      }

      // Skip error results — preserve diagnostics (e.g. file not found).
      if (tr.is_error) {
        return block;
      }

      changed = true;
      dereferencedCount++;
      return { ...tr, content: REREAD_STUB } as ContentBlock;
    });

    return changed ? { ...msg, content: nextContent } : msg;
  });

  return {
    messages: dereferencedCount > 0 ? mapped : messages,
    dereferencedCount,
  };
}
