export interface SubagentParentNotification {
  taskId: string;
  message: string;
  metadata: Record<string, unknown>;
  cronRunId?: string | null;
}
