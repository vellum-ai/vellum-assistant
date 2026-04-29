// ---------------------------------------------------------------------------
// Memory v2 — Static context loader for user-message auto-injection
// ---------------------------------------------------------------------------
//
// Reads the four top-level memory files (essentials/threads/recent/buffer)
// and returns a concatenated, header-wrapped block ready to splice into the
// current user message via the injector chain.
//
// Pairs with the v2 per-turn activation block (`prependMemoryV2Block` in
// `conversation-graph-memory.ts`) — that block carries activated concept
// pages selected by the activation pipeline; this static block carries the
// always-relevant aggregate views written by consolidation and the user.
// Both land on the user message so the system prompt stays cache-stable.
//
// Refresh cadence is owned by the caller: the agent loop only passes the
// content through when `mode === "full"` (first turn / post-compaction),
// matching the existing PKB auto-inject pattern.

import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
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
 * Build the v2 static memory block, gated on `memory-v2-enabled` +
 * `config.memory.v2.enabled`. Empty/missing files are skipped; returns
 * `null` when the gate is off or every file is empty.
 */
export function readMemoryV2StaticContent(): string | null {
  let config;
  try {
    config = loadConfig();
  } catch {
    return null;
  }
  if (
    !isAssistantFeatureFlagEnabled("memory-v2-enabled", config) ||
    !config.memory.v2.enabled
  ) {
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
