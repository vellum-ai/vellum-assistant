/**
 * Memory v3 — LLM-call capture types.
 *
 * A debugging seam: when a sink is threaded into the retrieval loop, every v3
 * LLM call (dense filter, each tree-walk descender call, the gate) emits one
 * {@link LlmCallRecord} carrying the full input it sent and the raw response it
 * got back. The `simulate` path collects these so an operator can inspect what
 * each call actually saw and returned. Nothing here is persisted, and the sink
 * is `undefined` on every non-simulate path, so production pays zero cost.
 *
 * Leaf module: it imports only provider types, so the lanes and the loop can
 * depend on it without a cycle.
 */

import type {
  Message,
  ProviderResponse,
  ToolDefinition,
} from "../../providers/types.js";

/**
 * One captured v3 LLM call — its full input (system prompt, messages, tool
 * schema) and raw output (provider response). `pass` is the 1-based retrieval
 * pass the call ran in; `node` is set only for the tree-walk descender (the
 * node whose composed index it judged). `ms` is the provider round-trip time.
 */
export interface LlmCallRecord {
  pass: number;
  lane: "filter" | "descent" | "gate";
  callSite: string;
  node?: string;
  request: {
    systemPrompt: string;
    messages: Message[];
    tools: ToolDefinition[];
  };
  response: ProviderResponse;
  ms: number;
}

/**
 * The sink a lane calls to emit a capture record. Lanes don't know their pass
 * number, so they emit without `pass` and the loop wraps the sink to stamp the
 * current pass. `undefined` on every non-capturing path (the common case).
 */
export type LlmCallSink = (record: Omit<LlmCallRecord, "pass">) => void;
