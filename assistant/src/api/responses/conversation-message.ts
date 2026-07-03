/**
 * Wire contract for the conversation history / messages endpoints.
 *
 *   - `GET /v1/assistants/:id/messages` → `{ messages: ConversationMessage[] }`
 *   - `POST /v1/messages` send acks echo an `assistantMessage: ConversationMessage`
 *
 * Holds the canonical history-row shape produced by the daemon's
 * `renderHistoryContent` + conversation-routes serializer and consumed by
 * every history client (web, CLI, evals). Defining it here — rather than
 * re-declaring it in the daemon's `http-types.ts` and again in the web's
 * `chat/api/messages.ts` — means the producer and all consumers derive from
 * one source and cannot drift.
 *
 * The arrays use a positional encoding:
 *   - `contentOrder` entries are `"<type>:<index>"` strings (e.g. `"text:0"`,
 *     `"thinking:1"`, `"tool:0"`, `"surface:0"`, `"attachment:0"`). The index
 *     points into the matching array below.
 *   - `textSegments`, `thinkingSegments` are plain string arrays.
 *   - `toolCalls`, `surfaces`, `attachments` are object arrays.
 *
 * Canonical wire-contract source. Assistant code imports the types directly
 * from this file via relative paths; external consumers (web client,
 * gateway, evals) import via `@vellumai/assistant-api`.
 */

import { z } from "zod";

import {
  AllowlistOptionSchema,
  DirectoryScopeOptionSchema,
  ScopeOptionSchema,
} from "../events/confirmation-request.js";
import { QuestionEntrySchema } from "../events/question-request.js";
import { ToolActivityMetadataSchema } from "../events/tool-result.js";

// ---------------------------------------------------------------------------
// Attachment metadata
// ---------------------------------------------------------------------------

/** Structured attachment metadata attached to a history row. */
export const ConversationMessageAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  kind: z.string(),
  /** Base64-encoded file data. Only populated for images on history reload. */
  data: z.string().optional(),
  /** Base64-encoded thumbnail, when one was generated. */
  thumbnailData: z.string().optional(),
  /** True when the attachment bytes are backed by a file on disk. */
  fileBacked: z.boolean().optional(),
});
export type ConversationMessageAttachment = z.infer<
  typeof ConversationMessageAttachmentSchema
>;

// ---------------------------------------------------------------------------
// Tool call
// ---------------------------------------------------------------------------

const RiskScopeOptionSchema = z.object({
  pattern: z.string(),
  label: z.string(),
});

const RiskAllowlistOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
  pattern: z.string(),
});

const RiskDirectoryScopeOptionSchema = z.object({
  scope: z.string(),
  label: z.string(),
});

/**
 * In-flight permission prompt awaiting a user decision, mirrored onto a
 * history tool call so a cold reconnect (or a conversation reopened after the
 * event-buffer window has elapsed) can restore the inline confirmation card
 * without replaying the live `confirmation_request` SSE event.
 *
 * The daemon stamps this at render time by consulting the in-memory
 * `pending-interactions` registry (the authoritative store of unresolved
 * prompts) — it is not persisted to the database, so it appears only while the
 * prompt is genuinely outstanding and disappears once the interaction
 * resolves. The shape mirrors the `confirmation_request` event the live path
 * delivers, so both paths hydrate the same client state.
 */
export const PendingToolConfirmationSchema = z.object({
  requestId: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  toolName: z.string().optional(),
  riskLevel: z.string().optional(),
  riskReason: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  allowlistOptions: z.array(AllowlistOptionSchema).optional(),
  scopeOptions: z.array(ScopeOptionSchema).optional(),
  directoryScopeOptions: z.array(DirectoryScopeOptionSchema).optional(),
  persistentDecisionsAllowed: z.boolean().optional(),
});
export type PendingToolConfirmation = z.infer<
  typeof PendingToolConfirmationSchema
>;

/**
 * In-flight `ask_question` prompt awaiting a user answer, mirrored onto the
 * history tool call that raised it so a cold reconnect (or a conversation
 * reopened after the event-buffer window has elapsed) can restore the inline
 * question card without replaying the live `question_request` SSE event.
 *
 * Stamped at render time from the in-memory `pending-interactions` registry
 * (the authoritative store of unresolved prompts) — not persisted to the
 * database, so it appears only while the prompt is genuinely outstanding and
 * disappears once the interaction resolves. `entries` mirrors the
 * `question_request` event's `questions[]`, so both paths hydrate the same
 * client state.
 */
export const PendingToolQuestionSchema = z.object({
  requestId: z.string(),
  entries: z.array(QuestionEntrySchema),
});
export type PendingToolQuestion = z.infer<typeof PendingToolQuestionSchema>;

/**
 * Closed set of confirmation outcomes recorded for a tool call. The daemon
 * only ever persists one of these three values (the outcome map is gated to
 * them in `conversation-agent-loop.ts`), so the wire carries the closed enum
 * rather than a free string and clients consume it without re-narrowing.
 */
export const ConfirmationDecisionSchema = z.enum([
  "approved",
  "denied",
  "timed_out",
]);
export type ConfirmationDecision = z.infer<typeof ConfirmationDecisionSchema>;

/**
 * A single tool call rendered into a history row. Mirrors the object the
 * daemon's `renderHistoryContent` emits; `contentOrder` references it as
 * `tool:N` where `N` indexes into `toolCalls`.
 */
export const ConversationMessageToolCallSchema = z.object({
  /** Stable tool-call id: the provider `tool_use` id, or a synthesized positional id. Guaranteed present as of daemon v0.8.8; optional for skew with older daemons. */
  id: z.string().optional(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  result: z.string().optional(),
  isError: z.boolean().optional(),
  /** Base64-encoded image data from tool contentBlocks. @deprecated Use imageDataList. */
  imageData: z.string().optional(),
  /** Base64-encoded image data from tool contentBlocks (e.g. browser_screenshot, image generation). */
  imageDataList: z.array(z.string()).optional(),
  /** Unix ms when the tool started executing (the `tool_use_start` time). */
  startedAt: z.number().optional(),
  /**
   * Unix ms when the tool call was first recognized in the model stream (the
   * `tool_use_preview_start` time), before its input finished streaming. The
   * user-perceived latency anchors here so a snapshot fetched mid-tool (refresh
   * / reconnect) restores the first-byte elapsed counter; the tool's own
   * execution latency stays `completedAt - startedAt`. Absent for tool calls
   * that produced no preview (e.g. native server tools) or older history rows.
   */
  previewStartedAt: z.number().optional(),
  /** Unix ms when the tool completed. */
  completedAt: z.number().optional(),
  /**
   * Confirmation outcome for this tool call, when one was recorded. Closed
   * enum: the daemon has only ever emitted these three values since the field
   * was introduced, so every daemon that carries it conforms — no version gate.
   */
  confirmationDecision: ConfirmationDecisionSchema.optional(),
  /** Friendly label for the confirmation (e.g. "Edit File", "Run Command"). */
  confirmationLabel: z.string().optional(),
  /** Risk level classification at invocation time ("low" | "medium" | "high" | "unknown"). */
  riskLevel: z.string().optional(),
  /** Human-readable reason for the risk classification. */
  riskReason: z.string().optional(),
  /** ID of the trust rule that matched this invocation (if any). */
  matchedTrustRuleId: z.string().optional(),
  /** @deprecated Use `approvalMode` and `approvalReason` instead. */
  autoApproved: z.boolean().optional(),
  /** How the approval decision was reached: prompted, auto, blocked, or unknown (legacy). */
  approvalMode: z.string().optional(),
  /** Why the approval decision was reached (stable enum for client display). */
  approvalReason: z.string().optional(),
  /** Snapshot of the auto-approve threshold at execution time. */
  riskThreshold: z.string().optional(),
  /** Display-only regex ladder for the rule editor (narrowest → broadest). */
  riskScopeOptions: z.array(RiskScopeOptionSchema).optional(),
  /** Minimatch save patterns for the rule editor (narrowest → broadest). */
  riskAllowlistOptions: z.array(RiskAllowlistOptionSchema).optional(),
  /** Directory scope ladder for the rule editor. */
  riskDirectoryScopeOptions: z.array(RiskDirectoryScopeOptionSchema).optional(),
  /**
   * Structured tool activity (web_search / web_fetch) for rich client cards.
   * Persisted alongside the tool call so the activity card survives a history
   * reopen instead of degrading to the plain `result` text. Mirrors the live
   * `tool_result` event's `activityMetadata`. Guaranteed present for tool calls
   * that produced activity as of daemon v0.8.8; absent for older history rows.
   */
  activityMetadata: ToolActivityMetadataSchema.optional(),
  /**
   * Confirmation scope ladder (`{label, scope}`) for scope-aware tools
   * (file/bash). Derived at render time via the permission checker's pure
   * `generateScopeOptions(workspaceDir, toolName)`, so it is reconstructed for
   * completed tool calls on history reopen rather than persisted. Feeds the
   * rule editor's trust-rule suggestion fallback. Distinct from the
   * regex-flavored `riskScopeOptions` (`{pattern, label}`). Guaranteed present
   * for scope-aware tools as of daemon v0.8.8; absent for older history rows.
   */
  scopeOptions: z.array(ScopeOptionSchema).optional(),
  /**
   * In-flight permission prompt, present only while the tool call is awaiting
   * a user decision (read from the `pending-interactions` registry at render
   * time). Lets a cold reconnect restore the inline confirmation card.
   * Guaranteed present for outstanding prompts as of daemon v0.8.8.
   */
  pendingConfirmation: PendingToolConfirmationSchema.optional(),
  /**
   * In-flight `ask_question` prompt, present only while the tool call is
   * awaiting a user answer (read from the `pending-interactions` registry at
   * render time). Lets a cold reconnect restore the inline question card.
   */
  pendingQuestion: PendingToolQuestionSchema.optional(),
});
export type ConversationMessageToolCall = z.infer<
  typeof ConversationMessageToolCallSchema
>;

// ---------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------

// Intentionally more permissive than the canonical SurfaceActionSchema in
// api/events/ui-surface-show.ts: the write-path schema uses z.enum for style
// so new surfaces only emit known values; this read-path schema uses z.string
// so historical surfaces with non-standard style values still parse.
const SurfaceActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  style: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/**
 * A UI surface (widget) embedded in a history row. `contentOrder` references
 * it as `surface:N` where `N` indexes into `surfaces`.
 */
export const ConversationMessageSurfaceSchema = z.object({
  surfaceId: z.string(),
  surfaceType: z.string(),
  title: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
  actions: z.array(SurfaceActionSchema).optional(),
  display: z.string().optional(),
  persistent: z.boolean().optional(),
  completed: z.boolean().optional(),
  completionSummary: z.string().optional(),
  /** Id of the tool call that produced this surface (the `ui_show` proxy tool). */
  toolCallId: z.string().optional(),
});
export type ConversationMessageSurface = z.infer<
  typeof ConversationMessageSurfaceSchema
>;

// ---------------------------------------------------------------------------
// Subagent notification
// ---------------------------------------------------------------------------

/** Daemon-injected subagent lifecycle notification attached to a history row. */
export const ConversationSubagentNotificationSchema = z.object({
  subagentId: z.string(),
  label: z.string(),
  status: z.string(),
  error: z.string().optional(),
  conversationId: z.string().optional(),
  objective: z.string().optional(),
});
export type ConversationSubagentNotification = z.infer<
  typeof ConversationSubagentNotificationSchema
>;

// ---------------------------------------------------------------------------
// ACP run notification
// ---------------------------------------------------------------------------

/** Daemon-injected ACP-run lifecycle notification attached to a history row. */
export const ConversationAcpNotificationSchema = z.object({
  acpSessionId: z.string(),
  agent: z.string().optional(),
});
export type ConversationAcpNotification = z.infer<
  typeof ConversationAcpNotificationSchema
>;

// ---------------------------------------------------------------------------
// Background-tool completion
// ---------------------------------------------------------------------------

/** Structured terminal record of a backgrounded bash/host_bash run, carrying
 *  everything a web `BackgroundTaskEntry` needs to rebuild a completed inline
 *  card from history. Mirrors the `background_tool_completed` SSE event plus
 *  the registry fields (`toolName`, `command`, `startedAt`). */
export const BackgroundToolCompletionSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  conversationId: z.string(),
  command: z.string(),
  startedAt: z.number(),
  status: z.enum(["completed", "failed", "cancelled"]),
  exitCode: z.number().nullable(),
  output: z.string(),
  completedAt: z.number(),
});
export type BackgroundToolCompletion = z.infer<
  typeof BackgroundToolCompletionSchema
>;

// ---------------------------------------------------------------------------
// Slack message envelope
// ---------------------------------------------------------------------------

const SlackMessageLinkSchema = z.object({
  appUrl: z.string().optional(),
  webUrl: z.string().optional(),
});

const SlackReactionSchema = z.object({
  emoji: z.string(),
  op: z.enum(["added", "removed"]),
  actorDisplayName: z.string().optional(),
  targetChannelTs: z.string(),
});

/** Slack provenance for a history row that originated from a Slack channel. */
export const ConversationSlackMessageSchema = z.object({
  channelId: z.string(),
  channelName: z.string().optional(),
  channelTs: z.string(),
  threadTs: z.string().optional(),
  sender: z
    .object({
      displayName: z.string().optional(),
      externalUserId: z.string().optional(),
    })
    .optional(),
  messageLink: SlackMessageLinkSchema.optional(),
  threadLink: SlackMessageLinkSchema.optional(),
  eventKind: z.enum(["message", "reaction"]).optional(),
  reaction: SlackReactionSchema.optional(),
});
export type ConversationSlackMessage = z.infer<
  typeof ConversationSlackMessageSchema
>;

// ---------------------------------------------------------------------------
// Content block (unified ordered content)
// ---------------------------------------------------------------------------

/** A run of assistant prose. */
export const ConversationTextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export type ConversationTextBlock = z.infer<typeof ConversationTextBlockSchema>;

/** A contiguous model reasoning run with its timing. */
export const ConversationThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  /** Unix ms when the model began emitting this reasoning block. */
  startedAt: z.number().optional(),
  /** Unix ms when this reasoning block completed. */
  completedAt: z.number().optional(),
});
export type ConversationThinkingBlock = z.infer<
  typeof ConversationThinkingBlockSchema
>;

/** A tool invocation carrying its paired result (`toolCall.result`). */
export const ConversationToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  toolCall: ConversationMessageToolCallSchema,
});
export type ConversationToolUseBlock = z.infer<
  typeof ConversationToolUseBlockSchema
>;

/** A vellum surface projection (no provider analog). */
export const ConversationSurfaceBlockSchema = z.object({
  type: z.literal("surface"),
  surface: ConversationMessageSurfaceSchema,
});
export type ConversationSurfaceBlock = z.infer<
  typeof ConversationSurfaceBlockSchema
>;

/** A vellum attachment projection (no provider analog). */
export const ConversationAttachmentBlockSchema = z.object({
  type: z.literal("attachment"),
  attachment: ConversationMessageAttachmentSchema,
});
export type ConversationAttachmentBlock = z.infer<
  typeof ConversationAttachmentBlockSchema
>;

/**
 * A single ordered content block. `contentBlocks` is the unified, display-ready
 * projection of a message's model-native content — one ordered tagged array so
 * clients render by mapping a single list instead of cross-referencing the
 * parallel positional arrays.
 *
 * Discriminants and field names mirror the model-loop `ContentBlock` union
 * (`providers/types.ts`) so logic reads the same whether it runs in a
 * plugin/hook (raw provider blocks) or on a client (this cleaned wire form).
 * The wire form differs from the raw provider union in three deliberate ways:
 *   - `tool_use` carries its paired result (`toolCall.result`): the daemon
 *     merges the separate `tool_result` block at read time so clients never
 *     re-pair calls with their results.
 *   - internal/sensitive provider fields are dropped (risk/approval scratch
 *     fields, raw base64 image bytes, provider thought signatures, opaque
 *     server-tool blobs).
 *   - vellum projections with no provider analog (`surface`, `attachment`)
 *     reuse the existing history schemas.
 *
 * The daemon builds this array directly from the model-native content while
 * rendering history (`renderHistoryContent`); the serializer never reconstructs
 * it from the positional arrays, so it stays correct once those are retired.
 */
export const ConversationContentBlockSchema = z.discriminatedUnion("type", [
  ConversationTextBlockSchema,
  ConversationThinkingBlockSchema,
  ConversationToolUseBlockSchema,
  ConversationSurfaceBlockSchema,
  ConversationAttachmentBlockSchema,
]);
export type ConversationContentBlock = z.infer<
  typeof ConversationContentBlockSchema
>;

// ---------------------------------------------------------------------------
// Conversation message (history row)
// ---------------------------------------------------------------------------

/**
 * A single consolidated history row as returned by the daemon's messages
 * endpoint. Consecutive assistant DB rows are merged into one display row;
 * `mergedMessageIds` records the folded ids.
 */
export const ConversationMessageSchema = z.object({
  id: z.string(),
  /**
   * Server message ids folded into this display row when consecutive
   * assistant messages were consolidated for history rendering.
   */
  mergedMessageIds: z.array(z.string()).optional(),
  /**
   * Client-generated idempotency nonce echoed back on the persisted row.
   * Present only for messages a client sent with one (user sends); lets the
   * client correlate an optimistic row with its confirmed server row by
   * identity instead of matching message text.
   */
  clientMessageId: z.string().optional(),
  /**
   * Renderable conversation roles only. The messages endpoint emits a
   * UI-facing transcript, so it excludes the `system` rows that the
   * underlying `MessageRole` column also permits — those are agent-context
   * scaffolding, never a displayed turn.
   */
  role: z.enum(["user", "assistant"]),
  /**
   * @deprecated Superseded by `contentBlocks`. Flat plain-text body (joined
   * text segments). Redundant with `textSegments`/`contentOrder` for clients
   * that render from the positional arrays (web, CLI). The serializer always
   * emits it — do not remove without auditing clients that read it directly.
   */
  content: z
    .string()
    .meta({
      deprecated: true,
      description:
        "Deprecated: superseded by contentBlocks. Flat plain-text body (joined text segments).",
    })
    .optional(),
  /** Display timestamp as an ISO-8601 string. */
  timestamp: z.string(),
  /**
   * Flat list of attachment metadata for the row. Not yet supersedable by
   * `contentBlocks`: `renderHistoryContent` emits an `attachment` content
   * block only for file-block refs with an inline placement, so orphan rows
   * (unmatched ids, count mismatch, no DB rows — see `alignAttachments`) ship
   * here alone. Kept non-deprecated until `contentBlocks` reaches attachment
   * parity, so clients that migrate off the positional arrays don't drop those
   * chips.
   */
  attachments: z.array(ConversationMessageAttachmentSchema),
  /**
   * @deprecated Superseded by `contentBlocks` (the `tool_use` variant). Flat
   * list of tool calls for the row.
   */
  toolCalls: z
    .array(ConversationMessageToolCallSchema)
    .meta({
      deprecated: true,
      description:
        "Deprecated: superseded by contentBlocks (the tool_use variant). Flat list of tool calls.",
    })
    .optional(),
  /**
   * @deprecated Superseded by `contentBlocks` (the `surface` variant). Flat
   * list of surfaces for the row.
   */
  surfaces: z
    .array(ConversationMessageSurfaceSchema)
    .meta({
      deprecated: true,
      description:
        "Deprecated: superseded by contentBlocks (the surface variant). Flat list of surfaces.",
    })
    .optional(),
  /**
   * @deprecated Superseded by `contentBlocks`. Text split by tool-call
   * boundaries; positional sibling of `contentOrder`.
   */
  textSegments: z
    .array(z.string())
    .meta({
      deprecated: true,
      description:
        "Deprecated: superseded by contentBlocks. Text segments split by tool-call boundaries.",
    })
    .optional(),
  /**
   * @deprecated Superseded by `contentBlocks`. Reasoning text extracted from
   * thinking blocks; positional sibling of `contentOrder`.
   */
  thinkingSegments: z
    .array(z.string())
    .meta({
      deprecated: true,
      description:
        "Deprecated: superseded by contentBlocks. Reasoning text extracted from thinking blocks.",
    })
    .optional(),
  /**
   * @deprecated Superseded by `contentBlocks`. Positional
   * `"<type>:<index>"` content ordering (e.g. `"text:0"`, `"thinking:1"`).
   */
  contentOrder: z
    .array(z.string())
    .meta({
      deprecated: true,
      description:
        'Deprecated: superseded by contentBlocks. Positional "<type>:<index>" content ordering (e.g. "text:0", "thinking:1").',
    })
    .optional(),
  /**
   * Unified ordered content blocks — the display-ready projection of the
   * row's model-native content. Ships alongside the positional
   * `contentOrder`/`textSegments`/`thinkingSegments` arrays during the client
   * migration; a client that consumes `contentBlocks` can ignore the
   * positional arrays entirely.
   */
  contentBlocks: z.array(ConversationContentBlockSchema).optional(),
  subagentNotification: ConversationSubagentNotificationSchema.optional(),
  acpNotification: ConversationAcpNotificationSchema.optional(),
  /** Set on any persisted `<background_event source="...">` wake trigger row.
   *  Like the subagent/ACP notifications, the row stays in state (the LLM reads
   *  it) but is filtered from the rendered transcript — the user-facing wake
   *  card carries the status. */
  backgroundEventNotification: z.boolean().optional(),
  /** Structured completion of a backgrounded bash/host_bash run, stamped on the
   *  same persisted background-event wake row as `backgroundEventNotification`.
   *  Lets the web reconstruct a terminal inline card after a daemon restart
   *  (the in-memory completed ring does not survive restarts). `id` equals the
   *  spawning tool call's `{backgrounded,id}` id. */
  backgroundToolCompletion: BackgroundToolCompletionSchema.optional(),
  slackMessage: ConversationSlackMessageSchema.optional(),
  /**
   * Queue state for a user message that is still waiting in the daemon's
   * in-memory queue (enqueued while the agent was mid-turn, not yet drained or
   * persisted to the database). Derived at render time from the live
   * conversation's queue, so it is present only while the message is genuinely
   * pending and lets a cold reload restore the queued rows the live
   * `message_queued` SSE events would otherwise be the only source of. Absent
   * on already-persisted rows. Mirrors the client `DisplayMessage` fields so
   * the wire and display shapes converge.
   */
  queueStatus: z.enum(["queued", "processing"]).optional(),
  /** 1-based position in the queue, mirroring the `message_queued` SSE event. */
  queuePosition: z.number().optional(),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
