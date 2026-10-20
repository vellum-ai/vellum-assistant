import { TrustClassSchema } from "@vellumai/gateway-client";
import { z } from "zod";

import {
  type ModeSession,
  parseModeSession,
  TolerantModeSessionSchema,
} from "../api/mode-session.js";
import type { InterfaceId } from "../channels/types.js";
import { CHANNEL_IDS, parseInterfaceId } from "../channels/types.js";
import { readProviderMetadata } from "../messaging/read-provider-metadata.js";
import { safeParseRecord } from "../util/json.js";
import {
  COMPUTER_USE_SCREENSHOT_ATTACHMENT_IDS_KEY,
  isNoResponseMetadata,
  isReactionMessageMetadata,
  isSystemCardMetadata,
} from "./conversation-types.js";

/**
 * The metadata JSON a message row holds after `updates` is shallow-merged
 * into its stored envelope: the merge behind `updateMessageMetadata` and
 * `updateMessageContentAndMetadata` in `conversation-crud.ts`. A malformed
 * stored envelope reads as empty, so the update stamping the row never fails
 * on it. An `undefined` value DELETES its key (`JSON.stringify` drops it),
 * which is how a caller removes a per-turn key the metadata schema types as
 * `string | absent`.
 */
export function mergeMessageMetadata(
  existing: string | null | undefined,
  updates: Record<string, unknown>,
): string {
  return JSON.stringify({
    ...(existing ? safeParseRecord(existing) : {}),
    ...updates,
  });
}

export function readModeSessionMetadata(
  metadata: string | null | undefined,
): ModeSession | undefined {
  if (!metadata) {
    return undefined;
  }
  return parseModeSession(safeParseRecord(metadata).modeSession);
}

export function readMessageSentAt(
  metadata: string | null | undefined,
): number | undefined {
  if (!metadata) {
    return undefined;
  }
  const sentAt = safeParseRecord(metadata).sentAt;
  return typeof sentAt === "number" &&
    Number.isInteger(sentAt) &&
    sentAt >= 0 &&
    Number.isFinite(new Date(sentAt).getTime())
    ? sentAt
    : undefined;
}

// ── Message metadata Zod schema ──────────────────────────────────────
// Validates the JSON stored in messages.metadata. Known fields are typed;
// extra keys are allowed via passthrough so callers can attach ad-hoc data.

const channelIdSchema = z.enum(CHANNEL_IDS);
// Accept both canonical INTERFACE_IDS and the legacy "vellum" alias,
// normalizing to "web" on read so downstream code only handles canonical IDs.
const interfaceIdSchema = z
  .string()
  .transform((v) => parseInterfaceId(v))
  .refine((v): v is InterfaceId => v !== null);

const subagentNotificationSchema = z.object({
  subagentId: z.string(),
  label: z.string(),
  status: z.enum(["running", "completed", "failed", "aborted"]),
  error: z.string().optional(),
  conversationId: z.string().optional(),
  objective: z.string().optional(),
});

const acpNotificationSchema = z.object({
  acpSessionId: z.string(),
  agent: z.string().optional(),
});

const backgroundToolCompletionMetadataSchema = z.object({
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

export const messageMetadataSchema = z
  .object({
    /** Immutable ownership of this transcript row by a recorded mode session. */
    modeSession: TolerantModeSessionSchema,
    /**
     * Epoch ms the content actually happened, when that differs from when
     * the row was written. Set wherever persistence lags the event: a queued
     * turn draining, or channel history imported long after the fact.
     * History serialization prefers it over `createdAt` for the display
     * timestamp.
     */
    sentAt: z.number().optional(),
    userMessageChannel: channelIdSchema.optional(),
    assistantMessageChannel: channelIdSchema.optional(),
    userMessageInterface: interfaceIdSchema.optional(),
    assistantMessageInterface: interfaceIdSchema.optional(),
    /**
     * Optional client-side metadata bag attached to user messages at persist
     * time. `os` carries the client-reported OS surface ("web" | "ios" |
     * "macos" | "windows" | "linux" | "android") from the request body's `clientOs`
     * field, stamped by `persistQueuedMessageBody`. The transport
     * `userMessageInterface` is
     * "web" for the web, mobile, and desktop apps alike, so this is the only
     * per-platform attribution. `browser_family` / `browser_version` /
     * `interface_version` (and an `os` override) come from the sanitized
     * `x-vellum-*` client-metadata headers read by `handleSendMessage`
     * (see `@vellumai/service-contracts/client-metadata`). Forwarded
     * verbatim onto `TurnTelemetryEvent.client` for downstream analytics.
     * Kept as a permissive `record` so adding a new client field doesn't
     * require a migration -- dbt can unpack later via JSON_VALUE.
     */
    client: z.record(z.string(), z.unknown()).optional(),
    /**
     * True when the `client.os` above was reported by this row's own request
     * or transport rather than inherited from the conversation's live client
     * state. `Conversation.clientOs` is refreshed only by a message that
     * carries transport metadata, so a transport-less turn (surface action,
     * signal ingress) stamps the OS of an earlier send. Consumers that must
     * not misattribute a turn to a surface require this marker (the
     * `chat.assistant_reply` presence gate, which drops the push when the Mac
     * that opened the turn is attended). Absent reads as "origin unknown".
     * Deliberately a sibling of `client` rather than an entry inside it:
     * `turn-events-store` forwards `$.client` verbatim onto
     * `TurnTelemetryEvent.client`.
     */
    clientOsFromRequest: z.boolean().optional(),
    subagentNotification: subagentNotificationSchema.optional(),
    acpNotification: acpNotificationSchema.optional(),
    /**
     * Trust class of the actor at the time this message was persisted.
     * This is a durable snapshot -- it does NOT change if the actor's
     * trust status changes later. Used by the memory write gate (indexer)
     * and read gate (conversation history loading) to enforce trust-aware access.
     */
    provenanceTrustClass: TrustClassSchema.optional(),
    /**
     * Model that actually served this assistant row, carried on the agent
     * loop's `message_complete` event (the provider's `response.model`, the
     * same value `llm_usage` records) and persisted with the finalized content.
     * Reflects per-call reroutes by a `pre-model-call` hook. Present only on
     * assistant rows produced by a real model call; absent on user rows,
     * tool-result rows, and synthetic assistant rows (provider-error / yield
     * notices). Turn-trace assembly surfaces it as the per-message
     * `TurnTraceMessage.model`.
     */
    model: z.string().optional(),
    provenanceSourceChannel: channelIdSchema.optional(),
    provenanceGuardianExternalUserId: z.string().optional(),
    provenanceRequesterIdentifier: z.string().optional(),
    /**
     * Contact id of the person who wrote this row, from the gateway trust
     * verdict at persist time. Stamped only on a person's own message or
     * reaction (`actorAuthorProvenance`), never on rows the assistant writes
     * during their turn: the other `provenance*` fields describe the turn,
     * this one the author. Absent when the author resolved to no contact.
     */
    provenanceContactId: z.string().optional(),
    /**
     * Set on a backfilled row whose sender was looked up but no usable gateway
     * verdict came back, so its trust class is the guardian-address fallback
     * and it names no author. Distinguishes that row from a sender the gateway
     * resolved as a stranger, so the lookup can be re-run later. Live ingress
     * never persists such a row: it denies a turn whose verdict failed.
     */
    provenanceLookupFailed: z.boolean().optional(),
    automated: z.boolean().optional(),
    /**
     * Transcript-suppression flag: the row is a machine signal (e.g. the
     * channel-setup wizard-close marker, the onboarding greeting kickoff),
     * persisted and LLM-visible but never rendered as a user message. Test
     * with {@link isHiddenMessageMetadata}; hidden rows are filtered from
     * list-messages and queued snapshots, skip the user_message_echo, and
     * are excluded from search/memory indexing and other consumers that
     * treat message text as organic user input.
     */
    hidden: z.boolean().optional(),
    /** A hidden voice continuation trigger whose finished reply can raise a push. */
    voiceContinuationResult: z.boolean().optional(),
    /**
     * Marks a role-`"user"` row that opened a live phone or in-app voice turn.
     * Test with {@link isVoiceSessionUserMessage}, which documents why the
     * channel/interface fields cannot stand in for it.
     */
    voiceSessionTurn: z.boolean().optional(),
    [COMPUTER_USE_SCREENSHOT_ATTACHMENT_IDS_KEY]: z
      .array(z.string())
      .optional(),
    /**
     * Discriminates daemon-authored rows from ordinary turns.
     * `"system_card"` marks pre-composed status cards (the /compact, /clean,
     * and summarize-up-to results); see {@link SYSTEM_CARD_MESSAGE_KIND}.
     * `"provider_error"` marks the synthetic assistant row the agent loop
     * persists when a turn dies on the provider-error path; see
     * {@link PROVIDER_ERROR_MESSAGE_KIND}. Kept as a plain string so unknown
     * future kinds never fail metadata validation.
     */
    messageKind: z.string().optional(),
    /**
     * How a role-`"assistant"` row's plain text reached the user, stamped only
     * by a turn that routed its reply through the `send_user_message` tool.
     * `"private"` marks working notes the user never saw, which every
     * user-facing read projects out (see `daemon/handlers/user-facing-content`);
     * `"visible"` marks a fallback turn whose raw text was surfaced and so must
     * render and deliver like any reply. Absent on every other row. Kept as a
     * plain string, like {@link messageKind}, so an unknown future value never
     * fails metadata validation.
     */
    assistantTextVisibility: z.string().optional(),
    /**
     * Stable classified error code (`ClassifiedConversationError.code`, e.g.
     * `"PROVIDER_BILLING"`) stamped alongside
     * `messageKind: "provider_error"` on persisted provider-failure rows.
     */
    providerErrorCode: z.string().optional(),
    /**
     * Classified error category (`ClassifiedConversationError.errorCategory`,
     * e.g. `"credits_exhausted"`) stamped alongside
     * `messageKind: "provider_error"`. Clients switch on this to pick a
     * themed rendering for the row.
     */
    providerErrorCategory: z.string().optional(),
    /**
     * Structured terminal record stamped onto a `<background_event
     * source="background-tool">` wake so the web can rebuild the inline
     * bash/host_bash card from history after a daemon restart.
     */
    backgroundToolCompletion: backgroundToolCompletionMetadataSchema.optional(),
    forkSourceMessageId: z.string().optional(),
    /** Image source paths from desktop attachments, keyed by filename. */
    imageSourcePaths: z.record(z.string(), z.string()).optional(),
    /**
     * Resolved paths of the canonical attachment copies in the conversation's
     * attachments/ directory (name collisions get a -2/-3 suffix), keyed by
     * `${position}:${filename}`. Written after the attachments are linked;
     * reinjected into LLM-facing content on history reload.
     */
    attachmentStoredPaths: z.record(z.string(), z.string()).optional(),
    /**
     * Marks a role-`"user"` row whose arrival interrupted a running turn.
     * `loadFromDb` rebuilds the LLM-facing `<interrupted_turn>` note from it;
     * the row's own content is exactly what the user sent, so clients render
     * nothing extra.
     */
    interruptedPriorTurn: z.boolean().optional(),
    memoryInjectedBlock: z.string().optional(),
    /** Memory-v3 frozen net-new section block (unwrapped), the v3
     *  counterpart of `memoryInjectedBlock`. A row carries at most one of the
     *  two. The key matches the memory plugin's
     *  `MEMORY_V3_INJECTED_BLOCK_METADATA_KEY`, kept as a literal here (like
     *  `memoryInjectedBlock`) so the storage schema does not import the memory
     *  feature. */
    memoryV3InjectedBlock: z.string().optional(),
    /** Rendering format of `memoryV3InjectedBlock`, stamped by the build
     *  that persisted it and compared on read against the memory plugin's
     *  `MEMORY_V3_INJECTED_BLOCK_FORMAT`; a row carrying the block without
     *  it holds a legacy compact-card block. The key matches the plugin's
     *  `MEMORY_V3_INJECTED_BLOCK_FORMAT_METADATA_KEY`, kept as a literal here
     *  so the storage schema does not import the memory feature. */
    memoryV3InjectedBlockFormat: z.number().optional(),
    /** Memory-v3 per-turn `<memory_pointer>` block (wrapped). Rehydrated by
     *  `loadFromDb` so historical turns keep the pointer they were sent with.
     *  The key matches the memory plugin's
     *  `MEMORY_V3_POINTER_BLOCK_METADATA_KEY`, kept as a literal here so the
     *  storage schema does not import the memory feature. */
    memoryV3PointerBlock: z.string().optional(),
    /** Persisted `<memory_spotlight>` text (wrapped) from earlier builds that
     *  shipped the per-turn spotlight layer. Never written; `loadFromDb`
     *  rehydrates it verbatim as inert history so the prompts those turns
     *  were sent with stay byte-identical across the upgrade. The key matches
     *  the memory plugin's `LEGACY_MEMORY_V3_SPOTLIGHT_BLOCK_METADATA_KEY`. */
    memoryV3SpotlightBlock: z.string().optional(),
    turnContextBlock: z.string().optional(),
    pkbSystemReminderBlock: z.string().optional(),
    workspaceBlock: z.string().optional(),
    nowScratchpadBlock: z.string().optional(),
    pkbContextBlock: z.string().optional(),
    memoryV2StaticBlock: z.string().optional(),
    /** `<background_turn>` block (background/scheduled non-interactive turns),
     *  rehydrated by `loadFromDb` for reload/fork prefix-cache parity. */
    backgroundTurnBlock: z.string().optional(),
    /** `<channel_capabilities>` block, rehydrated for the same reason. */
    channelCapabilitiesBlock: z.string().optional(),
    /** `<non_interactive_context>` block, rehydrated for the same reason. */
    nonInteractiveContextBlock: z.string().optional(),
  })
  .passthrough();

/** Validated shape of a persisted message's `metadata` column. */
export type MessageMetadata = z.infer<typeof messageMetadataSchema>;

/**
 * Pure predicates over the `metadata` record above. They live in the
 * `conversation-types` leaf so a caller that only classifies a row does not
 * pull in this module's DB graph, and are re-exported here alongside the
 * schema they read.
 */
export {
  isBackgroundEventMetadata,
  isEchoSuppressedUserMessage,
  isHiddenMessageMetadata,
  isSuppressedQueuedMessage,
  isVoiceSessionUserMessage,
} from "./conversation-types.js";

/**
 * The system-card `messageKind` marker and its predicate live in the
 * `conversation-types` leaf so a caller that only stamps or classifies the
 * marker does not pull in this module's DB graph, and are re-exported here
 * alongside the schema that carries them.
 */
export {
  isNoResponseMetadata,
  isSystemCardMetadata,
  NO_RESPONSE_MESSAGE_KIND,
  REACTION_MESSAGE_KIND,
  SYSTEM_CARD_MESSAGE_KIND,
} from "./conversation-types.js";

/**
 * `messageKind` value marking the synthetic assistant row the agent loop
 * persists when a turn terminates on the provider-error path (see the
 * `persistProviderErrorAsAssistantMessage` branch). The row's text stays in
 * LLM history like any assistant message; the marker (plus the
 * `providerErrorCode`/`providerErrorCategory` fields stamped next to it) lets
 * clients render the row as a themed notice instead of persona speech.
 */
export const PROVIDER_ERROR_MESSAGE_KIND = "provider_error";

/**
 * Shared predicate for the provider-error marker on assistant-message
 * metadata (see the `messageKind` field on {@link messageMetadataSchema}).
 * One definition so persistence stamping and wire projection cannot drift.
 */
export function isProviderErrorMetadata(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return metadata?.messageKind === PROVIDER_ERROR_MESSAGE_KIND;
}

/**
 * True when an assistant row is a standalone display turn: a system card, a
 * provider-error notice, a deliberate-silence marker, a reaction, or a row
 * deleted on its channel. Standalone rows never merge with adjacent
 * assistant rows, and turn grouping closes on them, so display merging and
 * the turn resolver agree on boundaries. Takes the raw persisted `metadata`
 * JSON string; malformed JSON and non-assistant roles are never standalone.
 *
 * The web folds adjacent assistant rows again after pagination and reads the
 * same rule off the wire projection in its own `isStandaloneAssistantMessage`
 * (clients/web/src/domains/chat/utils/is-standalone-assistant-message.ts). A
 * kind added here without a matching flag and check there merges on the
 * client anyway.
 */
export function isStandaloneAssistantMessage(
  role: string,
  metadata: string | null,
): boolean {
  if (role !== "assistant" || !metadata) {
    return false;
  }
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return (
      isSystemCardMetadata(parsed) ||
      isProviderErrorMetadata(parsed) ||
      isNoResponseMetadata(parsed) ||
      isReactionMessageMetadata(parsed) ||
      isChannelDeletedMetadata(metadata)
    );
  } catch {
    return false;
  }
}

/**
 * True when the row was deleted on its channel after it was stored. The
 * marker lives in the provider envelope rather than in `messageKind`, so a
 * merged run would take the anchor's envelope and either drop the deletion
 * or claim it over text that is still visible. The substring guard keeps the
 * envelope parse off rows that cannot carry it.
 */
export function isChannelDeletedMetadata(metadata: string): boolean {
  return (
    metadata.includes("deletedAt") &&
    readProviderMetadata(metadata)?.deletedAt !== undefined
  );
}

/**
 * Parse a persisted message's metadata JSON against {@link messageMetadataSchema},
 * the single source of truth for its shape, returning the validated fields,
 * or `undefined` when the column is absent, not valid JSON, or fails validation.
 * The single place the raw JSON.parse + safeParse dance lives, so callers read
 * typed fields (e.g. `provenanceTrustClass`, `automated`, `subagentNotification`)
 * instead of re-implementing it.
 */
export function parseMessageMetadata(
  metadataJson: string | null,
): MessageMetadata | undefined {
  if (!metadataJson) {
    return undefined;
  }
  try {
    const parsed = messageMetadataSchema.safeParse(JSON.parse(metadataJson));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
