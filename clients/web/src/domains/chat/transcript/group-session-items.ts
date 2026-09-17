import type { ModeSession, ModeSessionSummary } from "@vellumai/assistant-api";

import type { DisplayMessage } from "@/domains/chat/types/types";
import type {
  MessageItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";

import { normalizeSessionTimestamp } from "./session-group-summary";
import {
  messageItemHasIdentity,
  messageItemIdentityIds,
  messageItemMembers,
} from "./transcript-message-identity";

export interface SessionGroupSegment {
  kind: "sessionGroup";
  key: string;
  modeSession: ModeSession;
  summary: ModeSessionSummary;
  items: MessageItem[];
  rawMemberMessageIds: string[];
  memberMessageIds: string[];
  firstActivityAt: number | null;
  lastActivityAt: number | null;
  containsFirstBoundary: boolean;
  containsLastBoundary: boolean;
}

export type SessionGroupIdentity = Pick<
  SessionGroupSegment,
  "key" | "modeSession" | "rawMemberMessageIds" | "memberMessageIds"
>;

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

export function sameSessionGroupIdentity(
  left: SessionGroupIdentity,
  right: SessionGroupIdentity,
): boolean {
  return (
    left.key === right.key &&
    sameModeSession(left.modeSession, right.modeSession) &&
    sameIds(left.rawMemberMessageIds, right.rawMemberMessageIds) &&
    sameIds(left.memberMessageIds, right.memberMessageIds)
  );
}

export type SessionGroupedTranscriptItem = TranscriptItem | SessionGroupSegment;

export interface SessionMemberActivityBounds {
  firstActivityAt: number | null;
  lastActivityAt: number | null;
}

export interface GroupSessionItemsInput {
  items: TranscriptItem[];
  conversationId: string;
  summariesById: ReadonlyMap<string, ModeSessionSummary>;
  getModeSession: (message: DisplayMessage) => ModeSession | null | undefined;
  getActivityBounds?: (message: DisplayMessage) => SessionMemberActivityBounds;
  previousSegments?: readonly SessionGroupIdentity[];
}

interface EligibleMessageItem {
  item: MessageItem;
  modeSession: ModeSession;
  summary: ModeSessionSummary;
}

function sameModeSession(a: ModeSession, b: ModeSession): boolean {
  return a.id === b.id && a.mode === b.mode;
}

function eligibleMessageItem(
  item: TranscriptItem,
  input: GroupSessionItemsInput,
): EligibleMessageItem | null {
  if (item.kind !== "message") {
    return null;
  }

  let modeSession: ModeSession | null = null;
  for (const message of messageItemMembers(item)) {
    const membership = input.getModeSession(message);
    if (!membership) {
      return null;
    }
    if (modeSession && !sameModeSession(modeSession, membership)) {
      return null;
    }
    modeSession = membership;
  }
  if (!modeSession) {
    return null;
  }

  const summary = input.summariesById.get(modeSession.id);
  if (
    !summary ||
    summary.conversationId !== input.conversationId ||
    summary.id !== modeSession.id ||
    summary.mode !== modeSession.mode
  ) {
    return null;
  }
  return { item, modeSession, summary };
}

function defaultActivityBounds(
  message: DisplayMessage,
): SessionMemberActivityBounds {
  const timestamp = normalizeSessionTimestamp(message.timestamp);
  return { firstActivityAt: timestamp, lastActivityAt: timestamp };
}

function segmentActivity(
  items: MessageItem[],
  getActivityBounds: NonNullable<GroupSessionItemsInput["getActivityBounds"]>,
): SessionMemberActivityBounds {
  let firstActivityAt: number | null = null;
  let lastActivityAt: number | null = null;
  for (const item of items) {
    for (const message of messageItemMembers(item)) {
      const bounds = getActivityBounds(message);
      const first = normalizeSessionTimestamp(bounds.firstActivityAt);
      const last = normalizeSessionTimestamp(bounds.lastActivityAt);
      if (first !== null) {
        firstActivityAt =
          firstActivityAt === null ? first : Math.min(firstActivityAt, first);
      }
      if (last !== null) {
        lastActivityAt =
          lastActivityAt === null ? last : Math.max(lastActivityAt, last);
      }
    }
  }
  return { firstActivityAt, lastActivityAt };
}

function createSegment(
  eligibleItems: EligibleMessageItem[],
  input: GroupSessionItemsInput,
  claimedPreviousKeys: Set<string>,
): SessionGroupedTranscriptItem[] {
  const first = eligibleItems[0];
  if (!first) {
    return [];
  }
  const firstAssistantIndex = eligibleItems.findIndex(
    ({ item }) => item.message.role === "assistant",
  );
  if (firstAssistantIndex === -1) {
    return eligibleItems.map(({ item }) => item);
  }

  const includedStart =
    first.modeSession.mode === "live_vision" ? 0 : firstAssistantIndex;
  const prefix = eligibleItems
    .slice(0, includedStart)
    .map<SessionGroupedTranscriptItem>(({ item }) => item);
  const rawMemberMessageIds = eligibleItems.flatMap(({ item }) =>
    messageItemIdentityIds(item),
  );
  const items = eligibleItems.slice(includedStart).map(({ item }) => item);
  const memberMessageIds = items.flatMap((item) =>
    messageItemIdentityIds(item),
  );
  const firstIdentity = memberMessageIds[0] ?? items[0]!.key;
  const previous = input.previousSegments?.find(
    (candidate) =>
      !claimedPreviousKeys.has(candidate.key) &&
      sameModeSession(candidate.modeSession, first.modeSession) &&
      candidate.rawMemberMessageIds.some((id) =>
        rawMemberMessageIds.includes(id),
      ),
  );
  if (previous) {
    claimedPreviousKeys.add(previous.key);
  }
  const activity = segmentActivity(
    items,
    input.getActivityBounds ?? defaultActivityBounds,
  );
  const segment: SessionGroupSegment = {
    kind: "sessionGroup",
    key:
      previous?.key ?? `session-group:${first.modeSession.id}:${firstIdentity}`,
    modeSession: first.modeSession,
    summary: first.summary,
    items,
    rawMemberMessageIds:
      previous && sameIds(previous.rawMemberMessageIds, rawMemberMessageIds)
        ? previous.rawMemberMessageIds
        : rawMemberMessageIds,
    memberMessageIds:
      previous && sameIds(previous.memberMessageIds, memberMessageIds)
        ? previous.memberMessageIds
        : memberMessageIds,
    ...activity,
    containsFirstBoundary: items.some((item) =>
      messageItemHasIdentity(item, first.summary.firstIncludedMessageId),
    ),
    containsLastBoundary: items.some((item) =>
      messageItemHasIdentity(item, first.summary.lastOwnedMessageId),
    ),
  };
  return [...prefix, segment];
}

/**
 * Projects a flat transcript into contiguous recorded-session segments.
 * Canonical transcript items remain untouched and in order.
 */
export function groupSessionItems(
  input: GroupSessionItemsInput,
): SessionGroupedTranscriptItem[] {
  const grouped: SessionGroupedTranscriptItem[] = [];
  const claimedPreviousKeys = new Set<string>();
  let pending: EligibleMessageItem[] = [];

  function flush(): void {
    grouped.push(...createSegment(pending, input, claimedPreviousKeys));
    pending = [];
  }

  for (const item of input.items) {
    const eligible = eligibleMessageItem(item, input);
    const previous = pending[pending.length - 1];
    if (
      eligible &&
      (!previous || sameModeSession(previous.modeSession, eligible.modeSession))
    ) {
      pending.push(eligible);
      continue;
    }

    flush();
    if (eligible) {
      pending.push(eligible);
    } else {
      grouped.push(item);
    }
  }
  flush();
  return grouped;
}
