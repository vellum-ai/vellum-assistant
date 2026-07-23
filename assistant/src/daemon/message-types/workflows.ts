// Workflow orchestration run lifecycle events.
//
// Emitted by the `WorkflowRunManager` (run-manager.ts) as a workflow run
// progresses and completes. These are server → client push events only — the
// run is launched via the workflow tool / scheduler / routes (later PRs), not
// via a client message in this union.
//
// The events are single-sourced from their canonical `api/events` wire
// schemas; this file only composes them into the domain union consumed by
// `message-protocol.ts`.

import type { WorkflowCompletedEvent } from "../../api/events/workflow-completed.js";
import type { WorkflowLeafFinishedEvent } from "../../api/events/workflow-leaf-finished.js";
import type { WorkflowLeafStartedEvent } from "../../api/events/workflow-leaf-started.js";
import type { WorkflowProgressEvent } from "../../api/events/workflow-progress.js";
import type { WorkflowStartedEvent } from "../../api/events/workflow-started.js";

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _WorkflowsServerMessages =
  | WorkflowProgressEvent
  | WorkflowCompletedEvent
  | WorkflowStartedEvent
  | WorkflowLeafStartedEvent
  | WorkflowLeafFinishedEvent;
