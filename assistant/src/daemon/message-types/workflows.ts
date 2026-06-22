// Workflow orchestration run lifecycle events.
//
// Emitted by the `WorkflowRunManager` (run-manager.ts) as a workflow run
// progresses and completes. These are server → client push events only — the
// run is launched via the workflow tool / scheduler / routes (later PRs), not
// via a client message in this union.

import type { WorkflowRunStatus } from "../../workflows/journal-store.js";

// === Server → Client ===

/**
 * Progress push for an in-flight workflow run. Maps the engine's
 * `onProgress` (`phase`/`log`) callback plus the current usage snapshot into a
 * single wire event. `phase` carries the latest `phase(title)`; `message`
 * carries the latest `log(msg)`; only one is set per emission.
 */
export interface WorkflowProgress {
  type: "workflow_progress";
  runId: string;
  /**
   * Originating conversation id, when launched from one; lets `broadcastMessage`
   * auto-scope + seq-stamp the event to that conversation's SSE stream. Omitted
   * for a conversationless run (e.g. a scheduled workflow), which broadcasts
   * unscoped for raw SSE listeners and the DB record.
   */
  conversationId?: string;
  /** Latest phase title, when this emission came from a `phase(...)` call. */
  phase?: string;
  /** Run label (the workflow's `meta.name`), for client display. */
  label?: string;
  /** Live agent count at emission time. */
  agentsSpawned: number;
  /** Latest log line, when this emission came from a `log(...)` call. */
  message?: string;
}

/**
 * Terminal push for a workflow run. Carries the final status, counts, token
 * usage, and a human-readable result/error summary the originating
 * conversation also receives via an agent wake.
 */
export interface WorkflowCompleted {
  type: "workflow_completed";
  runId: string;
  /**
   * Originating conversation id, when launched from one; lets `broadcastMessage`
   * auto-scope + seq-stamp the event to that conversation's SSE stream. Omitted
   * for a conversationless run (e.g. a scheduled workflow), which broadcasts
   * unscoped for raw SSE listeners and the DB record.
   */
  conversationId?: string;
  status: WorkflowRunStatus;
  agentsSpawned: number;
  inputTokens: number;
  outputTokens: number;
  /** Human-readable result-or-error summary. */
  summary?: string;
}

/**
 * A workflow run has started. Emitted once at launch, before any leaf events.
 */
export interface WorkflowStarted {
  type: "workflow_started";
  runId: string;
  /**
   * Originating conversation id; lets `broadcastMessage` auto-scope +
   * seq-stamp the event to the conversation's SSE stream.
   */
  conversationId: string;
  /**
   * Tool-use id of the `skill_execute` block that launched this run, for
   * anchoring the inline workflow card to the exact spawn tool call.
   */
  toolUseId?: string;
  /** Run label (the workflow's `meta.name`), for client display. */
  label?: string;
}

/**
 * A leaf agent within a workflow run has started. `seq` orders leaves within
 * the run for stable client-side tree placement.
 */
export interface WorkflowLeafStarted {
  type: "workflow_leaf_started";
  runId: string;
  /**
   * Originating conversation id; lets `broadcastMessage` auto-scope +
   * seq-stamp the event to the conversation's SSE stream.
   */
  conversationId: string;
  seq: number;
  /** Leaf label, for client display. */
  label?: string;
  /** Phase the leaf belongs to, when the workflow declares phases. */
  phase?: string;
  /** Short summary of the leaf's prompt, for client display. */
  promptSummary?: string;
}

/**
 * A leaf agent within a workflow run has finished. `seq` matches the
 * corresponding `workflow_leaf_started` event.
 */
export interface WorkflowLeafFinished {
  type: "workflow_leaf_finished";
  runId: string;
  /**
   * Originating conversation id; lets `broadcastMessage` auto-scope +
   * seq-stamp the event to the conversation's SSE stream.
   */
  conversationId: string;
  seq: number;
  status: "completed" | "failed";
  /** Leaf label, for client display. */
  label?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Short summary of the leaf's result, for client display. */
  resultSummary?: string;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _WorkflowsServerMessages =
  | WorkflowProgress
  | WorkflowCompleted
  | WorkflowStarted
  | WorkflowLeafStarted
  | WorkflowLeafFinished;
