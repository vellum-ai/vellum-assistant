// ---------------------------------------------------------------------------
// Memory v2 — Static context loader for user-message auto-injection
// ---------------------------------------------------------------------------
//
// Reads the four top-level memory files (essentials/threads/recent/buffer)
// and returns a concatenated, header-wrapped block ready to splice into the
// current user message via the injector chain.
//
// Pairs with the v2 per-turn activation block (`maybeRouteV2Injection` in
// `conversation-graph-memory.ts`, which threads through `injectTextBlock`)
// — that block carries activated concept pages selected by the activation
// pipeline; this static block carries the always-relevant aggregate views
// written by consolidation and the user. Both land on the user message so
// the system prompt stays cache-stable.
//
// Refresh cadence is owned by the caller: the agent loop only passes the
// content through when `mode === "full"` (first turn / post-compaction),
// matching the existing PKB auto-inject pattern.

import type { ChannelId } from "../../channels/types.js";
import { loadConfig } from "../../config/loader.js";
import { readPromptFile } from "../../prompts/system-prompt.js";
import { getWorkspacePromptPath } from "../../util/platform.js";

interface MemoryV2StaticBlock {
  heading: string;
  file: string;
}

const MEMORY_V2_STATIC_BLOCKS: readonly MemoryV2StaticBlock[] = [
  { heading: "## Essentials", file: "memory/essentials.md" },
  { heading: "## Threads", file: "memory/threads.md" },
  { heading: "## Recent", file: "memory/recent.md" },
  { heading: "## Buffer", file: "memory/buffer.md" },
];

/**
 * Build the v2 static memory block, gated on `config.memory.v2.enabled`.
 * Empty/missing files are skipped; returns `null` when the gate is off or
 * every file is empty.
 */
export function readMemoryV2StaticContent(): string | null {
  let config;
  try {
    config = loadConfig();
  } catch {
    return null;
  }
  if (!config.memory.v2.enabled) {
    return null;
  }

  const sections: string[] = [];
  for (const { heading, file } of MEMORY_V2_STATIC_BLOCKS) {
    const content = readPromptFile(getWorkspacePromptPath(file));
    if (!content) continue;
    sections.push(`${heading}\n\n${content}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : null;
}

/**
 * Static memory holds the user's aggregate personal pages
 * (essentials/threads/recent/buffer). Block injection when a non-guardian
 * actor reaches the assistant over a remote channel — otherwise the model
 * can be prompt-injected into reciting private memory. Internal flows
 * (`sourceChannel: "vellum"`) and turns with no trust context pass through
 * unchanged; this gate exists only to keep remote untrusted actors out.
 *
 * This is the trust-only gate. Cadence (first-turn / post-compaction) is
 * applied separately by the caller so that `currentMemoryV2Static` remains
 * available for re-injection after a mid-turn reducer-triggered compaction
 * — the initial-injection turn may not have been a `shouldInjectNowAndPkb`
 * turn, but compaction strips the existing `<memory>` block and we still
 * need the freshest content to re-inject.
 */
export function shouldLoadMemoryV2Static(args: {
  sourceChannel: ChannelId | undefined;
  isTrustedActor: boolean;
}): boolean {
  const isRemoteUntrustedActor =
    args.sourceChannel !== undefined &&
    args.sourceChannel !== "vellum" &&
    !args.isTrustedActor;
  return !isRemoteUntrustedActor;
}
