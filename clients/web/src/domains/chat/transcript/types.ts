// Pure types for the windowed transcript. This module must stay free of
// React / DOM imports so `buildTranscriptItems` and `partitionLatestTurn`
// can be unit-tested under `bun test` without a Node test runner.

import type {
  DisplayMessage,
  EphemeralMetaResult,
  Surface,
} from "@/domains/chat/types/types";
import type { RuntimeSubagentNotification } from "@/domains/chat/api/messages";
import type { BackgroundTaskEntry } from "@/domains/chat/background-task-store";
import type { MessagesGetResponse } from "@/generated/daemon/types.gen";

export type TranscriptItemKind =
  | "message"
  | "thinking"
  | "pendingSecret"
  | "pendingConfirmation"
  | "pendingContactRequest"
  | "surface"
  | "ephemeralMeta"
  | "onboardingChoice";

export interface TranscriptItemBase {
  key: string;
  kind: TranscriptItemKind;
}

export interface MessageItem extends TranscriptItemBase {
  kind: "message";
  message: DisplayMessage;
}

export interface ThinkingItem extends TranscriptItemBase {
  kind: "thinking";
  /** Daemon-provided activity label (e.g. "Processing bash results").
   *  When absent, the render layer falls back to a generic default. */
  label?: string;
  /**
   * Whether the shimmering label is currently visible. The item itself exists
   * for the WHOLE in-flight turn (a fixed-height slot, so the transcript never
   * reflows), while `active` fades the label in during the gaps where no other
   * affordance — streaming text, a shimmering inline thinking link, a pending
   * prompt — is signaling progress (see `shouldShowThinkingIndicator`).
   */
  active: boolean;
}

export interface PendingSecretItem extends TranscriptItemBase {
  kind: "pendingSecret";
  requestId: string;
}

export interface PendingConfirmationItem extends TranscriptItemBase {
  kind: "pendingConfirmation";
  requestId: string;
}

export interface PendingContactRequestItem extends TranscriptItemBase {
  kind: "pendingContactRequest";
  requestId: string;
  /** Channel type hint from the daemon (e.g. "phone", "email"). */
  channel?: string;
  placeholder?: string;
  label?: string;
  description?: string;
  role?: string;
}

export interface SurfaceItem extends TranscriptItemBase {
  kind: "surface";
  surface: Surface;
}

export interface OnboardingChoiceItem extends TranscriptItemBase {
  kind: "onboardingChoice";
}

export interface EphemeralMetaItem extends TranscriptItemBase {
  kind: "ephemeralMeta";
  result: EphemeralMetaResult;
}

export type TranscriptItem =
  | MessageItem
  | ThinkingItem
  | PendingSecretItem
  | PendingConfirmationItem
  | PendingContactRequestItem
  | SurfaceItem
  | EphemeralMetaItem
  | OnboardingChoiceItem;

/** Result of splitting the transcript into stable history and the
 *  currently-in-progress turn. `anchorMessage` is the most recent user
 *  message (the pivot); everything before it is stable history the
 *  scroll coordinator can pin, everything after is the actively
 *  rendering response. */
export interface LatestTurnPartition {
  historyItems: TranscriptItem[];
  anchorMessage: MessageItem | null;
  responseItems: TranscriptItem[];
}

/** Result shape returned by the paginated history fetchers in `../history.ts`.
 *  Lives here so the transcript-state machine and the fetchers share a single
 *  source-of-truth definition.
 *
 *  The server-sourced page metadata (`hasMore`, the `oldest*` cursor, `seq`,
 *  the authoritative `processing` flag) is inherited straight from the wire
 *  contract so it can never drift from `/messages` — the fetcher fills the
 *  three cursor fields defensively (so they are `Required` here), while `seq`
 *  and `processing` keep the wire's optionality (`undefined` = an older daemon
 *  that omits the field; consult the generated type for their full semantics).
 *  Only `messages` genuinely differs: rendered `DisplayMessage`s, not the wire
 *  rows — plus the two client-derived extraction fields. */
export interface PaginatedHistoryResult
  extends Required<
      Pick<MessagesGetResponse, "hasMore" | "oldestTimestamp" | "oldestMessageId">
    >,
    Pick<MessagesGetResponse, "seq" | "processing"> {
  messages: DisplayMessage[];
  /** Subagent notifications extracted from history messages for state reconstruction. */
  subagentNotifications?: RuntimeSubagentNotification[];
  /** Background-task completion records extracted from history messages, used to
   *  re-seed completed inline cards across daemon restarts. The paginated
   *  fetchers always populate it (an empty array when no row carried a
   *  completion); it is optional so other constructors (snapshot spreads, tests)
   *  need not restate it. */
  backgroundToolCompletions?: BackgroundTaskEntry[];
}

/** Snapshot of the transcript pagination state held by the scroll
 *  coordinator. */
export interface TranscriptPaginationState {
  items: TranscriptItem[];
  hasMore: boolean;
  oldestTimestamp: number | null;
  isLoadingOlder: boolean;
}
