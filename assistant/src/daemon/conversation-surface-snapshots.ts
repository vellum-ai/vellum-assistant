/**
 * Canonical conversation surface snapshots for host readers.
 *
 * Combines an unbounded persisted `ui_surface` scan with the loaded
 * conversation's live `surfaceState` and current-turn snapshots. Hits from
 * the persisted scan are never written into `surfaceState`.
 */

import { coerceSurfaceDataRecord } from "../api/surfaces.js";
import { getMessages } from "../persistence/conversation-crud.js";
import { resolveCapabilities } from "../runtime/capabilities.js";
import { isPlainObject } from "../util/object.js";
import { findConversationOrSubagent } from "./conversation-registry.js";
import { isRowVisibleToUntrustedActor } from "./message-provenance.js";

export interface ConversationSurfaceSnapshot {
  surfaceId: string;
  surfaceType: string;
  data: Record<string, unknown>;
  completed: boolean;
  completionSummary?: string;
}

function cloneSurfaceData(value: unknown): Record<string, unknown> {
  const record = coerceSurfaceDataRecord(value);
  try {
    return structuredClone(record);
  } catch {
    return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  }
}

function surfaceTypeFromBlock(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : "dynamic_page";
}

function rememberOrder(order: string[], surfaceId: string): void {
  if (!order.includes(surfaceId)) {
    order.push(surfaceId);
  }
}

/**
 * Current surface snapshots for a loaded conversation.
 *
 * Fails closed to an empty list when the conversation is not already
 * loaded or the turn-or-resting trust snapshot is missing. Untrusted
 * views reuse {@link isRowVisibleToUntrustedActor} and do not add
 * live-only cards that never appeared in a visible persisted row.
 */
export function listConversationSurfaceSnapshots(
  conversationId: string,
): ConversationSurfaceSnapshot[] {
  const conversation = findConversationOrSubagent(conversationId);
  if (!conversation) {
    return [];
  }
  const trust = conversation.getTurnOrRestingTrust();
  if (!trust) {
    return [];
  }
  const canAccessMemory = resolveCapabilities(trust.trustClass).canAccessMemory;
  const filterByProvenance = !canAccessMemory;

  const order: string[] = [];
  const records = new Map<string, ConversationSurfaceSnapshot>();

  const rows = getMessages(conversationId);
  for (const row of rows) {
    if (filterByProvenance && !isRowVisibleToUntrustedActor(row.metadata)) {
      continue;
    }
    if (!Array.isArray(row.content)) {
      continue;
    }
    for (const block of row.content) {
      if (!isPlainObject(block) || block.type !== "ui_surface") {
        continue;
      }
      const surfaceId = block.surfaceId;
      if (typeof surfaceId !== "string" || surfaceId.length === 0) {
        continue;
      }
      const completionSummary =
        typeof block.completionSummary === "string"
          ? block.completionSummary
          : undefined;
      rememberOrder(order, surfaceId);
      records.set(surfaceId, {
        surfaceId,
        surfaceType: surfaceTypeFromBlock(block.surfaceType),
        data: cloneSurfaceData(block.data),
        completed: block.completed === true,
        ...(completionSummary !== undefined ? { completionSummary } : {}),
      });
    }
  }

  for (const [surfaceId, entry] of conversation.surfaceState.entries()) {
    const existing = records.get(surfaceId);
    if (!existing && filterByProvenance) {
      continue;
    }
    rememberOrder(order, surfaceId);
    records.set(surfaceId, {
      surfaceId,
      surfaceType: entry.surfaceType,
      data: cloneSurfaceData(entry.data),
      completed: existing?.completed === true,
      ...(existing?.completionSummary !== undefined
        ? { completionSummary: existing.completionSummary }
        : {}),
    });
  }

  for (const surface of conversation.currentTurnSurfaces) {
    const existing = records.get(surface.surfaceId);
    const completionSummary =
      typeof surface.completionSummary === "string"
        ? surface.completionSummary
        : existing?.completionSummary;
    rememberOrder(order, surface.surfaceId);
    records.set(surface.surfaceId, {
      surfaceId: surface.surfaceId,
      surfaceType: surface.surfaceType,
      data: cloneSurfaceData(surface.data),
      completed: surface.completed === true || existing?.completed === true,
      ...(completionSummary !== undefined ? { completionSummary } : {}),
    });
  }

  return order.map((surfaceId) => records.get(surfaceId)!);
}
