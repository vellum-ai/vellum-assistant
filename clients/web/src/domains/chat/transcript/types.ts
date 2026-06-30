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

/** Result shape returned by the paginated history fetchers in
 *  `../history.ts`. Lives here so the transcript-state machine and the
 *  fetchers share a single source-of-truth definition. */
export interface PaginatedHistoryResult {
  messages: DisplayMessage[];
  hasMore: boolean;
  oldestTimestamp: number | null;
  oldestMessageId: string | null;
  /** Subagent notifications extracted from history messages for state reconstruction. */
  subagentNotifications?: RuntimeSubagentNotification[];
  /** Background-task completion records extracted from history messages, used to
   *  re-seed completed inline cards across daemon restarts. The paginated
   *  fetchers always populate it (an empty array when no row carried a
   *  completion); it is optional so other constructors (snapshot spreads, tests)
   *  need not restate it. */
  backgroundToolCompletions?: BackgroundTaskEntry[];
  /** Global SSE `seq` this snapshot is durably persisted through for the
   *  conversation, or `null` when the daemon reports no honest position
   *  (cold conversation, post-restart, aged-out map, or an older daemon
   *  that omits the field). Used to align the snapshot with the `/events`
   *  stream. */
  seq?: number | null;
}

/** Snapshot of the transcript pagination state held by the scroll
 *  coordinator. */
export interface TranscriptPaginationState {
  items: TranscriptItem[];
  hasMore: boolean;
  oldestTimestamp: number | null;
  isLoadingOlder: boolean;
}
