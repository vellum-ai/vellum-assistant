/**
 * Plan lifecycle messages surfaced to connected clients.
 *
 * Counterpart to `action_lifecycle` (in `actions.ts`). The Autonomous
 * Execution Engine broadcasts these so thin clients (Tauri HUD) can show
 * multi-step plan progress without parsing tool-specific payloads.
 */

export type PlanLifecycleStage =
  | "started"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface PlanLifecycleMessage {
  type: "plan_lifecycle";
  planId: string;
  goal: string;
  stage: PlanLifecycleStage;
  ts: number;
  conversationId?: string;
  message?: string;
}

export type PlanStepLifecycleStage =
  | "started"
  | "executing"
  | "completed"
  | "failed"
  | "blocked";

export interface PlanStepLifecycleMessage {
  type: "plan_step_lifecycle";
  planId: string;
  stepId: string;
  stepOrder: number;
  stepName: string;
  attempt: number;
  stage: PlanStepLifecycleStage;
  ts: number;
  conversationId?: string;
  message?: string;
}

export type _PlansServerMessages =
  | PlanLifecycleMessage
  | PlanStepLifecycleMessage;
