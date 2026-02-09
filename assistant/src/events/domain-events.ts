import type { EventMap } from './bus.js';

export interface ToolDomainEvents extends EventMap {
  'tool.execution.started': {
    conversationId: string;
    sessionId: string;
    toolName: string;
    input: Record<string, unknown>;
    startedAtMs: number;
  };
  'tool.permission.requested': {
    conversationId: string;
    sessionId: string;
    toolName: string;
    riskLevel: string;
    requestedAtMs: number;
  };
  'tool.permission.decided': {
    conversationId: string;
    sessionId: string;
    toolName: string;
    decision: 'allow' | 'always_allow' | 'deny' | 'always_deny';
    riskLevel: string;
    decidedAtMs: number;
  };
  'tool.secret.detected': {
    conversationId: string;
    sessionId: string;
    toolName: string;
    action: 'redact' | 'warn' | 'block';
    matches: Array<{ type: string; redactedValue: string }>;
    detectedAtMs: number;
  };
  'tool.execution.finished': {
    conversationId: string;
    sessionId: string;
    toolName: string;
    decision: string;
    riskLevel: string;
    isError: boolean;
    durationMs: number;
    finishedAtMs: number;
  };
  'tool.execution.failed': {
    conversationId: string;
    sessionId: string;
    toolName: string;
    decision: string;
    riskLevel: string;
    durationMs: number;
    error: string;
    failedAtMs: number;
  };
}

export interface DaemonDomainEvents extends EventMap {
  'daemon.lifecycle.started': {
    pid: number;
    socketPath: string;
    startedAtMs: number;
  };
  'daemon.lifecycle.stopped': {
    stoppedAtMs: number;
  };
  'daemon.session.created': {
    conversationId: string;
    createdAtMs: number;
  };
  'daemon.session.evicted': {
    conversationId: string;
    reason: 'idle' | 'stale' | 'shutdown';
    evictedAtMs: number;
  };
}

export type AssistantDomainEvents = ToolDomainEvents & DaemonDomainEvents;
