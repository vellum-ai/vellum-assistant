import type { DisplayMessage, Surface } from "@/domains/chat/types/types";
import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";

export function messagesEqual(a: DisplayMessage[], b: DisplayMessage[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const am = a[i]!;
    const bm = b[i]!;
    if (
      am.id !== bm.id ||
      am.role !== bm.role ||
      am.content !== bm.content ||
      !!am.isStreaming !== !!bm.isStreaming ||
      am.timestamp !== bm.timestamp ||
      JSON.stringify(am.surfaces) !== JSON.stringify(bm.surfaces) ||
      JSON.stringify(am.textSegments) !== JSON.stringify(bm.textSegments) ||
      JSON.stringify(am.contentOrder) !== JSON.stringify(bm.contentOrder) ||
      JSON.stringify(am.metadata) !== JSON.stringify(bm.metadata) ||
      JSON.stringify(am.slackMessage) !== JSON.stringify(bm.slackMessage) ||
      JSON.stringify(am.toolCalls) !== JSON.stringify(bm.toolCalls) ||
      JSON.stringify(am.attachments) !== JSON.stringify(bm.attachments)
    ) {
      return false;
    }

    // Compare any arbitrary passthrough fields beyond the known set
    const knownKeys = new Set([
      "id",
      "role",
      "content",
      "isStreaming",
      "surfaces",
      "textSegments",
      "contentOrder",
      "metadata",
      "slackMessage",
      "toolCalls",
      "attachments",
      "timestamp",
      "queueStatus",
      "queuePosition",
    ]);
    const amKeys = Object.keys(am).filter((k) => !knownKeys.has(k));
    const bmKeys = Object.keys(bm).filter((k) => !knownKeys.has(k));
    if (amKeys.length !== bmKeys.length) return false;
    for (const key of new Set([...amKeys, ...bmKeys])) {
      if (JSON.stringify((am as unknown as Record<string, unknown>)[key]) !== JSON.stringify((bm as unknown as Record<string, unknown>)[key])) return false;
    }
  }
  return true;
}

export function mergeByKey<T>(
  current: T[] | undefined,
  incoming: T[] | undefined,
  getKey: (item: T) => string | undefined,
  mergeItem: (current: T, incoming: T) => T = (_current, incomingItem) => incomingItem,
): T[] | undefined {
  if (!current || current.length === 0) return incoming;
  if (!incoming || incoming.length === 0) return current;

  const merged = [...current];
  const indexByKey = new Map<string, number>();
  for (let i = 0; i < merged.length; i++) {
    const key = getKey(merged[i]!);
    if (key) indexByKey.set(key, i);
  }

  for (const item of incoming) {
    const key = getKey(item);
    const existingIdx = key ? indexByKey.get(key) : undefined;
    if (existingIdx == null) {
      if (key) indexByKey.set(key, merged.length);
      merged.push(item);
      continue;
    }

    merged[existingIdx] = mergeItem(merged[existingIdx]!, item);
  }

  return merged;
}

export function mergeToolCall(
  current: ChatMessageToolCall,
  incoming: ChatMessageToolCall,
): ChatMessageToolCall {
  const statusRank = { running: 0, completed: 1, error: 2 } as const;
  const preferred =
    statusRank[incoming.status] >= statusRank[current.status]
      ? incoming
      : current;
  const secondary = preferred === incoming ? current : incoming;
  return {
    ...secondary,
    ...preferred,
    startedAt: current.startedAt ?? incoming.startedAt,
    completedAt: preferred.completedAt ?? secondary.completedAt,
  };
}

export function mergeSurface(current: Surface, incoming: Surface): Surface {
  return {
    ...current,
    ...incoming,
    data: { ...current.data, ...incoming.data },
  };
}

function messageScore(message: DisplayMessage): number {
  let score = message.isStreaming ? 0 : 1_000_000;
  score += message.content.length;
  score += (message.textSegments?.length ?? 0) * 100;
  score += (message.contentOrder?.length ?? 0) * 100;
  score += (message.toolCalls?.length ?? 0) * 100;
  score += (message.surfaces?.length ?? 0) * 50;
  score += (message.attachments?.length ?? 0) * 50;
  score += message.timestamp == null ? 0 : 1;
  return score;
}

export function mergeDuplicateMessages(
  current: DisplayMessage,
  incoming: DisplayMessage,
): DisplayMessage {
  const preferred =
    messageScore(incoming) >= messageScore(current) ? incoming : current;
  const secondary = preferred === incoming ? current : incoming;
  const merged: DisplayMessage = {
    ...secondary,
    ...preferred,
  };

  if (current.isStreaming || incoming.isStreaming) {
    merged.isStreaming = Boolean(current.isStreaming && incoming.isStreaming);
  }

  if (merged.timestamp == null) {
    merged.timestamp = current.timestamp ?? incoming.timestamp;
  }

  const toolCalls = mergeByKey(
    current.toolCalls,
    incoming.toolCalls,
    (toolCall) => toolCall.id,
    mergeToolCall,
  );
  if (toolCalls) merged.toolCalls = toolCalls;

  const surfaces = mergeByKey(
    current.surfaces,
    incoming.surfaces,
    (surface) => surface.surfaceId,
    mergeSurface,
  );
  if (surfaces) merged.surfaces = surfaces;

  const attachments = mergeByKey(
    current.attachments,
    incoming.attachments,
    (attachment) => attachment.id || attachment.filename,
  );
  if (attachments) merged.attachments = attachments;

  if (current.metadata || incoming.metadata) {
    merged.metadata = {
      ...(current.metadata ?? {}),
      ...(incoming.metadata ?? {}),
      ...(preferred.metadata ?? {}),
    };
  }
  if (current.slackMessage || incoming.slackMessage) {
    merged.slackMessage = incoming.slackMessage ?? current.slackMessage;
  }

  if (!merged.contentOrder) {
    merged.contentOrder = current.contentOrder ?? incoming.contentOrder;
  }
  if (!merged.textSegments) {
    merged.textSegments = current.textSegments ?? incoming.textSegments;
  }

  return merged;
}

function pickMoreCompleteArray<T>(
  current: T[] | undefined,
  incoming: T[] | undefined,
): T[] | undefined {
  if (!current || current.length === 0) return incoming;
  if (!incoming || incoming.length === 0) return current;
  return incoming.length >= current.length ? incoming : current;
}

export function mergeLatestHistoryMessage(
  current: DisplayMessage,
  incoming: DisplayMessage,
): DisplayMessage {
  const currentHasMoreText = current.content.length > incoming.content.length;
  const preferredText = currentHasMoreText ? current : incoming;
  const merged: DisplayMessage = {
    ...current,
    ...incoming,
    content: preferredText.content,
  };

  // `isStreaming` is a client-owned, live-only flag. Server snapshots
  // (history pages, reconcile fetches) never carry it, so we must never
  // let the merge clear it based on `incoming.isStreaming` being absent.
  // The previous `else if (!incoming.isStreaming)` branch caused the
  // live assistant bubble to flip to "completed" mid-turn when a sync
  // tag fired a history merge during the stream — splitting the bubble
  // on the next `tool_use_start`. Always preserve the current value.
  merged.isStreaming = current.isStreaming;
  if (currentHasMoreText) {
    merged.textSegments = current.textSegments ?? incoming.textSegments;
  }

  if (incoming.role === "user" && incoming.id) {
    delete merged.queueStatus;
    delete merged.queuePosition;
  }

  // Server id arrived → the row is no longer optimistic.
  if (incoming.id && current.isOptimistic) {
    delete merged.isOptimistic;
  }

  const toolCalls = mergeByKey(
    current.toolCalls,
    incoming.toolCalls,
    (toolCall) => toolCall.id,
    mergeToolCall,
  );
  if (toolCalls) merged.toolCalls = toolCalls;

  const surfaces = mergeByKey(
    current.surfaces,
    incoming.surfaces,
    (surface) => surface.surfaceId,
    mergeSurface,
  );
  if (surfaces) merged.surfaces = surfaces;

  const attachments = mergeByKey(
    current.attachments,
    incoming.attachments,
    (attachment) => attachment.id || attachment.filename,
  );
  if (attachments) merged.attachments = attachments;

  const contentOrder = pickMoreCompleteArray(
    current.contentOrder,
    incoming.contentOrder,
  );
  if (contentOrder) merged.contentOrder = contentOrder;

  const textSegments = currentHasMoreText
    ? current.textSegments ?? incoming.textSegments
    : pickMoreCompleteArray(current.textSegments, incoming.textSegments);
  if (textSegments) merged.textSegments = textSegments;

  if (current.metadata || incoming.metadata) {
    merged.metadata = {
      ...(current.metadata ?? {}),
      ...(incoming.metadata ?? {}),
    };
  }
  if (current.slackMessage || incoming.slackMessage) {
    merged.slackMessage = incoming.slackMessage ?? current.slackMessage;
  }

  if (merged.timestamp == null) {
    merged.timestamp = current.timestamp ?? incoming.timestamp;
  }

  return merged;
}

function dedupeMessagesByKey(
  messages: DisplayMessage[],
  getKey: (message: DisplayMessage) => string | undefined,
): DisplayMessage[] {
  let result: DisplayMessage[] | null = null;
  const indexByKey = new Map<string, number>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    const key = getKey(message);
    if (!key) {
      if (result) result.push(message);
      continue;
    }

    const existingIdx = indexByKey.get(key);
    if (existingIdx == null) {
      indexByKey.set(key, result ? result.length : i);
      if (result) result.push(message);
      continue;
    }

    if (!result) {
      result = messages.slice(0, i);
    }
    result[existingIdx] = mergeDuplicateMessages(
      result[existingIdx]!,
      message,
    );
  }

  return result ?? messages;
}

/** Collapse duplicate display messages keyed by `id`. */
export function dedupeDisplayMessages(
  messages: DisplayMessage[],
): DisplayMessage[] {
  return dedupeMessagesByKey(messages, (message) => message.id);
}
