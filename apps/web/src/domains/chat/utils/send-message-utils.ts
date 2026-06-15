/**
 * Pure utility functions for the send-message domain.
 *
 * These are framework-agnostic, stateless transforms used by
 * `useSendMessage` and suitable for direct unit testing.
 */

import { isSurfaceInteractive, type DisplayMessage } from "@/domains/chat/types/types";

import { attachConfirmationToToolCall, ERROR_MESSAGES } from "@/domains/chat/utils/chat";
import {
  filterMessageSurfaces,
  mapMessageSurfaces,
} from "@/domains/chat/utils/map-message-surfaces";
import { mapMessageToolCalls } from "@/domains/chat/utils/map-message-tool-calls";
import type { PendingConfirmationState, PendingSecretState } from "@/domains/chat/types";
import type { AllowlistOption, DirectoryScopeOption, ScopeOption } from "@/types/interaction-ui-types";

const OPTIMISTIC_COMPLETION_SURFACE_TYPES = [
  "choice",
  "oauth_connect",
  "form",
  "confirmation",
  "file_upload",
  "card",
  "list",
  "table",
  "browser_view",
  "task_preferences",
];

// ---------------------------------------------------------------------------
// Pure updater functions — no React state, fully testable
// ---------------------------------------------------------------------------

/**
 * Remove `pendingConfirmation` from a specific request ID's tool calls.
 * Suitable as a React functional state updater:
 * `setMessages(prev => clearConfirmationByRequestId(prev, requestId))`
 */
export function clearConfirmationByRequestId(
  prev: DisplayMessage[],
  requestId: string,
): DisplayMessage[] {
  let anyChanged = false;
  const updated = prev.map((msg) => {
    const next = mapMessageToolCalls(msg, (tc) =>
      tc.pendingConfirmation?.requestId === requestId
        ? { ...tc, pendingConfirmation: undefined }
        : tc,
    );
    if (next !== msg) {
      anyChanged = true;
    }
    return next;
  });
  return anyChanged ? updated : prev;
}

/**
 * Remove `pendingConfirmation` from every tool call in a message list.
 * Suitable as a React functional state updater.
 */
export function clearPendingConfirmationsFromMessages(
  prev: DisplayMessage[],
): DisplayMessage[] {
  let anyChanged = false;
  const updated = prev.map((msg) => {
    const next = mapMessageToolCalls(msg, (tc) =>
      tc.pendingConfirmation
        ? { ...tc, pendingConfirmation: undefined }
        : tc,
    );
    if (next !== msg) {
      anyChanged = true;
    }
    return next;
  });
  return anyChanged ? updated : prev;
}

/**
 * Dismiss all interactive surfaces from messages and return the set of
 * dismissed IDs alongside the updated messages.
 */
export function dismissInteractiveSurfaces(
  prev: DisplayMessage[],
  messagesForScan: DisplayMessage[],
): { updatedMessages: DisplayMessage[]; dismissedIds: Set<string> } {
  const interactiveIds = new Set<string>();
  for (const msg of messagesForScan) {
    if (!msg.surfaces) continue;
    for (const s of msg.surfaces) {
      if (isSurfaceInteractive(s)) interactiveIds.add(s.surfaceId);
    }
  }
  if (interactiveIds.size === 0) {
    return { updatedMessages: prev, dismissedIds: interactiveIds };
  }
  const updatedMessages = prev.map((msg) =>
    filterMessageSurfaces(msg, (s) => !interactiveIds.has(s.surfaceId)),
  );
  return { updatedMessages, dismissedIds: interactiveIds };
}

export function completeSubmittedSurface(
  prev: DisplayMessage[],
  surfaceId: string,
  actionId: string,
  replyText?: string,
): DisplayMessage[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    const surface = prev[i]!.surfaces?.find((s) => s.surfaceId === surfaceId);
    if (!surface) continue;
    if (!OPTIMISTIC_COMPLETION_SURFACE_TYPES.includes(surface.surfaceType)) {
      return prev;
    }
    const matchedAction = surface.actions?.find((a) => a.id === actionId);
    const isCancellation =
      actionId === "cancel" ||
      actionId === "dismiss" ||
      matchedAction?.style === "secondary";
    const updated = [...prev];
    updated[i] = mapMessageSurfaces(prev[i]!, (s) =>
      s.surfaceId === surfaceId
        ? {
            ...s,
            completed: true,
            completionSummary: isCancellation
              ? "Cancelled"
              : replyText ?? matchedAction?.label ?? undefined,
          }
        : s,
    );
    return updated;
  }
  return prev;
}

/**
 * Resolve a human-readable error message from a POST result error.
 * Centralises the `ERROR_MESSAGES[code] ?? detail ?? fallback` pattern.
 */
export function resolvePostError(
  code: string | null | undefined,
  detail: string | undefined,
  fallback: string,
): string {
  return (code && ERROR_MESSAGES[code]) || detail || fallback;
}

// ---------------------------------------------------------------------------
// Parsing helpers — type-safe conversion from untyped API responses.
//
// `getPendingInteractions` returns `Record<string, unknown>` for both the
// secret and confirmation payloads. These helpers centralise the repetitive
// field-by-field type narrowing into small, testable functions.
// ---------------------------------------------------------------------------

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function optionalBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function optionalStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? (v as string[]) : undefined;
}

function optionalRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function optionalTypedArray<T>(v: unknown): T[] | undefined {
  return Array.isArray(v) ? (v as T[]) : undefined;
}

export function parsePendingSecretState(raw: Record<string, unknown>): PendingSecretState {
  return {
    requestId: typeof raw.requestId === "string" ? raw.requestId : "",
    label: optionalString(raw.label),
    description: optionalString(raw.description),
    placeholder: optionalString(raw.placeholder),
    allowOneTimeSend: optionalBoolean(raw.allowOneTimeSend),
    allowedTools: optionalStringArray(raw.allowedTools),
    allowedDomains: optionalStringArray(raw.allowedDomains),
    purpose: optionalString(raw.purpose),
  };
}

export function parsePendingConfirmationData(
  raw: Record<string, unknown>,
): { confData: Parameters<typeof attachConfirmationToToolCall>[1]; state: PendingConfirmationState } {
  const confData = {
    requestId: typeof raw.requestId === "string" ? raw.requestId : "",
    title: optionalString(raw.title),
    description: optionalString(raw.description),
    toolName: optionalString(raw.toolName),
    riskLevel: optionalString(raw.riskLevel),
    riskReason: optionalString(raw.riskReason),
    allowlistOptions: optionalTypedArray<AllowlistOption>(raw.allowlistOptions),
    scopeOptions: optionalTypedArray<ScopeOption>(raw.scopeOptions),
    directoryScopeOptions: optionalTypedArray<DirectoryScopeOption>(raw.directoryScopeOptions),
    persistentDecisionsAllowed: optionalBoolean(raw.persistentDecisionsAllowed),
    input: optionalRecord(raw.input),
    toolUseId: optionalString(raw.toolUseId),
  };
  const state: PendingConfirmationState = {
    ...confData,
    confirmLabel: optionalString(raw.confirmLabel),
    denyLabel: optionalString(raw.denyLabel),
  };
  return { confData, state };
}

/** Generate a unique turn ID for correlating the send → reconcile lifecycle. */
export function newTurnId(): string {
  return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
