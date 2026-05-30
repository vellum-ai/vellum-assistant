/**
 * Legacy parsers for user-facing interaction prompt events.
 *
 * Each function coerces a raw SSE payload into a typed event for one
 * of the four daemon-initiated prompts that require the user to
 * respond: secret entry, tool-risk confirmation, contact sharing,
 * and multi-option questions.
 */

import type { AssistantEvent } from "@/types/event-types";
import type {
  AllowlistOption,
  DirectoryScopeOption,
  QuestionEntry,
  QuestionOption,
  ScopeOption,
} from "@/types/interaction-ui-types";

export function parseSecretRequest(
  data: Record<string, unknown>,
): AssistantEvent {
  return {
    type: "secret_request",
    requestId: typeof data.requestId === "string" ? data.requestId : "",
    service: typeof data.service === "string" ? data.service : undefined,
    field: typeof data.field === "string" ? data.field : undefined,
    label: typeof data.label === "string" ? data.label : undefined,
    description:
      typeof data.description === "string" ? data.description : undefined,
    placeholder:
      typeof data.placeholder === "string" ? data.placeholder : undefined,
    allowOneTimeSend:
      typeof data.allowOneTimeSend === "boolean"
        ? data.allowOneTimeSend
        : undefined,
    allowedTools: Array.isArray(data.allowedTools)
      ? (data.allowedTools as string[])
      : undefined,
    allowedDomains: Array.isArray(data.allowedDomains)
      ? (data.allowedDomains as string[])
      : undefined,
    purpose: typeof data.purpose === "string" ? data.purpose : undefined,
    conversationId:
      typeof data.conversationId === "string"
        ? data.conversationId
        : undefined,
  };
}

export function parseConfirmationRequest(
  data: Record<string, unknown>,
): AssistantEvent {
  return {
    type: "confirmation_request",
    requestId: typeof data.requestId === "string" ? data.requestId : "",
    title: typeof data.title === "string" ? data.title : undefined,
    description:
      typeof data.description === "string" ? data.description : undefined,
    confirmLabel:
      typeof data.confirmLabel === "string" ? data.confirmLabel : undefined,
    denyLabel:
      typeof data.denyLabel === "string" ? data.denyLabel : undefined,
    conversationId:
      typeof data.conversationId === "string"
        ? data.conversationId
        : undefined,
    toolName: typeof data.toolName === "string" ? data.toolName : undefined,
    executionTarget:
      typeof data.executionTarget === "string"
        ? data.executionTarget
        : undefined,
    riskLevel:
      typeof data.riskLevel === "string" ? data.riskLevel : undefined,
    riskReason:
      typeof data.riskReason === "string" ? data.riskReason : undefined,
    allowlistOptions: Array.isArray(data.allowlistOptions)
      ? (data.allowlistOptions as AllowlistOption[])
      : undefined,
    scopeOptions: Array.isArray(data.scopeOptions)
      ? (data.scopeOptions as ScopeOption[])
      : undefined,
    directoryScopeOptions: Array.isArray(data.directoryScopeOptions)
      ? (data.directoryScopeOptions as DirectoryScopeOption[])
      : undefined,
    persistentDecisionsAllowed:
      typeof data.persistentDecisionsAllowed === "boolean"
        ? data.persistentDecisionsAllowed
        : undefined,
    input:
      typeof data.input === "object" &&
      data.input !== null &&
      !Array.isArray(data.input)
        ? (data.input as Record<string, unknown>)
        : undefined,
    toolUseId:
      typeof data.toolUseId === "string" ? data.toolUseId : undefined,
  };
}

export function parseContactRequest(
  data: Record<string, unknown>,
): AssistantEvent {
  return {
    type: "contact_request",
    requestId: typeof data.requestId === "string" ? data.requestId : "",
    channel: typeof data.channel === "string" ? data.channel : undefined,
    placeholder:
      typeof data.placeholder === "string" ? data.placeholder : undefined,
    label: typeof data.label === "string" ? data.label : undefined,
    description:
      typeof data.description === "string" ? data.description : undefined,
    role: typeof data.role === "string" ? data.role : undefined,
    conversationId:
      typeof data.conversationId === "string"
        ? data.conversationId
        : undefined,
  };
}

export function parseQuestionRequest(
  data: Record<string, unknown>,
): AssistantEvent {
  const requestId =
    typeof data.requestId === "string" ? data.requestId : "";
  const options: QuestionOption[] | undefined = Array.isArray(data.options)
    ? (data.options as QuestionOption[])
    : undefined;
  const questions: QuestionEntry[] | undefined = Array.isArray(data.questions)
    ? (data.questions as QuestionEntry[])
    : undefined;
  return {
    type: "question_request",
    requestId,
    questions,
    question: typeof data.question === "string" ? data.question : undefined,
    description:
      typeof data.description === "string" ? data.description : undefined,
    options,
    freeTextPlaceholder:
      typeof data.freeTextPlaceholder === "string"
        ? data.freeTextPlaceholder
        : undefined,
    conversationId:
      typeof data.conversationId === "string"
        ? data.conversationId
        : undefined,
    toolUseId:
      typeof data.toolUseId === "string" ? data.toolUseId : undefined,
  };
}
