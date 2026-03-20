export interface ToolDomainEvents {
  "tool.execution.started": {
    conversationId: string;
    requestId?: string;
    toolName: string;
    input: Record<string, unknown>;
    startedAtMs: number;
  };
  "tool.permission.requested": {
    conversationId: string;
    requestId?: string;
    toolName: string;
    riskLevel: string;
    requestedAtMs: number;
  };
  "tool.permission.decided": {
    conversationId: string;
    requestId?: string;
    toolName: string;
    decision:
      | "allow"
      | "allow_10m"
      | "allow_conversation"
      | "always_allow"
      | "always_allow_high_risk"
      | "deny"
      | "always_deny"
      | "temporary_override"
      | "dangerously_skip_permissions";
    riskLevel: string;
    decidedAtMs: number;
  };
  "tool.secret.detected": {
    conversationId: string;
    requestId?: string;
    toolName: string;
    action: "redact" | "warn" | "block" | "prompt";
    matches: Array<{ type: string; redactedValue: string }>;
    detectedAtMs: number;
  };
  "tool.execution.finished": {
    conversationId: string;
    requestId?: string;
    toolName: string;
    decision: string;
    riskLevel: string;
    isError: boolean;
    durationMs: number;
    finishedAtMs: number;
  };
  "tool.execution.failed": {
    conversationId: string;
    requestId?: string;
    toolName: string;
    decision: string;
    riskLevel: string;
    durationMs: number;
    error: string;
    isExpected: boolean;
    errorName?: string;
    errorStack?: string;
    failedAtMs: number;
  };
}

export interface DaemonDomainEvents {
  "daemon.lifecycle.started": {
    pid: number;
    startedAtMs: number;
  };
  "daemon.lifecycle.stopped": {
    stoppedAtMs: number;
  };
  "daemon.conversation.created": {
    conversationId: string;
    createdAtMs: number;
  };
  "daemon.conversation.evicted": {
    conversationId: string;
    reason: "idle" | "stale" | "shutdown";
    evictedAtMs: number;
  };
}

export type AssistantDomainEvents = ToolDomainEvents & DaemonDomainEvents;
