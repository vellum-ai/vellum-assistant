/**
 * Subagent → parent notification, decoupled from the SubagentManager.
 *
 * Routing (which parent a notification reaches) is taken from the live child
 * `Conversation`, which records its parent at spawn and is not writable by the
 * subagent's own sandbox tools. The durable subagent record supplies only the
 * cosmetic label/fork/objective metadata for the notification text. Keeping the
 * manager out of the import graph lets tool modules import these helpers without
 * pulling in the conversation/agent-loop core.
 *
 * An active live-voice session owns delivery for its conversation. Otherwise,
 * delivery targets the parent's in-process `Conversation` via the registry.
 * A stale idle parent is rebuilt through `getOrCreateConversation` first so
 * the injected turn uses the current provider, prompt, and credentials.
 */

import { runWhenConversationIdle } from "../daemon/conversation-admission.js";
import {
  findConversation,
  findConversationOrSubagent,
} from "../daemon/conversation-registry.js";
import { deliverSubagentNotificationToLiveVoice } from "../live-voice/live-voice-manager.js";
import { getSubagentRecordByConversationId } from "../persistence/subagent-store.js";
import { getLogger } from "../util/logger.js";
import { type SubagentStatus, TERMINAL_STATUSES } from "./types.js";

const log = getLogger("subagent-notify");

/**
 * Deliver task updates through the parent's live voice session when present,
 * otherwise run a parent turn once the parent is free to take one. No-op with
 * a warning when neither the session nor the parent conversation is live here.
 *
 * Shared by the child-triggered {@link notifyParentFromChild} and the
 * manager's terminal/abort injections so every subagent → parent turn lands
 * through one path.
 */
export function injectMessageIntoParent(
  parentConversationId: string,
  message: string,
  metadata?: Record<string, unknown>,
  opts?: { cronRunId?: string | null; bypassLiveVoice?: boolean },
): void {
  const notification = metadata?.subagentNotification;
  // The live child's conversation ID is stable even if its cosmetic record changes.
  if (
    !opts?.bypassLiveVoice &&
    notification !== null &&
    typeof notification === "object" &&
    "subagentId" in notification &&
    typeof notification.subagentId === "string" &&
    metadata !== undefined &&
    deliverSubagentNotificationToLiveVoice(parentConversationId, {
      taskId:
        "conversationId" in notification &&
        typeof notification.conversationId === "string"
          ? notification.conversationId
          : notification.subagentId,
      message,
      metadata,
      cronRunId: opts?.cronRunId,
    })
  ) {
    return;
  }
  const existing = findConversation(parentConversationId);
  if (!existing) {
    log.warn(
      { parentConversationId },
      "Subagent notification target parent conversation not found",
    );
    return;
  }
  // A reload can mark the parent stale while children still run. Terminal
  // injection is the first parent turn after the last child settles, so
  // rebuild first when the instance is idle. Otherwise the completion turn
  // would run on the construction-time provider, prompt, and credentials.
  if (existing.isStale() && !existing.hasInFlightWork()) {
    void import("../daemon/conversation-store.js")
      .then(({ getOrCreateConversation }) =>
        getOrCreateConversation(parentConversationId),
      )
      .then((parent) =>
        deliverToParent(parent, parentConversationId, message, metadata, opts),
      )
      .catch((err) => {
        log.error(
          { parentConversationId, err },
          "Failed to rebuild stale parent before subagent notification",
        );
      });
    return;
  }
  deliverToParent(existing, parentConversationId, message, metadata, opts);
}

/** The slice of the parent `Conversation` a notification turn drives. */
interface NotificationTarget {
  persistUserMessage: (options: {
    content: string;
    metadata?: Record<string, unknown>;
  }) => Promise<{ id: string }>;
  runAgentLoop: (
    content: string,
    userMessageId: string,
    options?: { isInteractive?: boolean; cronRunId?: string | null },
  ) => Promise<unknown>;
}

function deliverToParent(
  parentConversation: NotificationTarget,
  parentConversationId: string,
  message: string,
  metadata?: Record<string, unknown>,
  opts?: { cronRunId?: string | null },
): void {
  // The continuation this notification starts is still the scheduled firing's
  // work, so it carries the same run id as the child whose result triggered it.
  const cronRunId = opts?.cronRunId ?? null;
  void runWhenConversationIdle(
    parentConversationId,
    async () => {
      const { id: userMessageId } = await parentConversation.persistUserMessage(
        {
          content: message,
          metadata: { ...metadata, scripted: true },
        },
      );
      // Machine-injected with no human asserted present, so the notification
      // turn runs non-interactive; it still streams to whoever is watching
      // through the parent's sink. Awaited so the admission slot covers the
      // whole turn and the next notification lands after it.
      await parentConversation.runAgentLoop(message, userMessageId, {
        isInteractive: false,
        ...(cronRunId ? { cronRunId } : {}),
      });
    },
    { origin: "subagent_notification" },
  ).catch((err: unknown) => {
    log.error(
      { parentConversationId, err },
      "Failed to deliver subagent notification to parent",
    );
  });
}

/**
 * Deliver a mid-run notification from a subagent to its parent conversation.
 *
 * The parent is resolved from the live child conversation's `parentConversationId`
 * (set at spawn, not writable by the subagent), so a subagent cannot redirect
 * the notification to another conversation by tampering with its durable record.
 *
 * Returns `false` when `childConversationId` is not a live subagent, or when the
 * subagent has already reached a terminal status (the parent receives the
 * terminal summary through a separate path); `true` when the notification was
 * injected into the parent.
 */
export function notifyParentFromChild(
  childConversationId: string,
  message: string,
  urgency: string,
): boolean {
  const child = findConversationOrSubagent(childConversationId);
  const parentConversationId = child?.parentConversationId;
  if (parentConversationId === undefined) {
    return false;
  }

  // A synchronous (spawnAndAwait) child's only parent channel is the awaiting
  // caller: injecting a user-role turn into the live parent mid-await would
  // start an unsolicited parent run (e.g. unprompted activity on a live voice
  // call whose continuation is meant to stay silent until resurfaced).
  if (child?.subagentSuppressParentNotifications) {
    return false;
  }

  // Cosmetic metadata only — a tampered record can at most mislabel a
  // notification to the child's own (routing is fixed to the live parent above).
  const record = getSubagentRecordByConversationId(childConversationId);
  if (record && TERMINAL_STATUSES.has(record.status as SubagentStatus)) {
    return false;
  }
  const label = record?.label ?? "subagent";
  const isFork = record?.isFork ?? false;

  const prefix = isFork ? "Fork" : "Subagent";
  let notificationString = `[${prefix} "${label}" — ${urgency}] ${message}`;
  if (urgency === "blocked") {
    notificationString += `\nUse subagent_message to send guidance to this ${prefix.toLowerCase()}.`;
  }

  injectMessageIntoParent(parentConversationId, notificationString, {
    subagentNotification: {
      subagentId: record?.id ?? childConversationId,
      label,
      status: "running" as const,
      conversationId: childConversationId,
      objective: record?.objective ?? "",
    },
  });
  return true;
}
