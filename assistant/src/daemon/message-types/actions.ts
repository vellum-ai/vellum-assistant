/**
 * Action lifecycle messages surfaced to connected clients.
 *
 * These events let thin clients (e.g. Tauri HUD) show host-action progress
 * without parsing tool-specific payloads.
 */

export type ActionLifecycleStage =
  | "started"
  | "executing"
  | "completed"
  | "failed"
  | "rollback_started"
  | "rollback_completed";

export interface ActionLifecycleMessage {
  type: "action_lifecycle";
  actionId: string;
  actionName: string;
  stage: ActionLifecycleStage;
  ts: number;
  message?: string;
  conversationId?: string;
}

export type _ActionsServerMessages = ActionLifecycleMessage;
