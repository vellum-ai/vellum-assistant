/**
 * Validates the links a skill-update receipt offers: every skill it names,
 * against the installed skills list, and every source conversation, by id.
 *
 * A receipt outlives what it points at the same way a single-entity
 * notification does (`use-feed-item-entity-links.ts`), only it names several
 * things at once. Each is checked against the same read that vouches for it
 * elsewhere in the bell, so a receipt cannot link to a skill the footer would
 * refuse, and a source conversation that was garbage collected reads as plain
 * text rather than a dead link.
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { FeedItemUpdate } from "@vellumai/assistant-api";

import { feedItemConversationExistsQueryOptions } from "./use-feed-item-conversation-link";
import { installedSkillsQueryOptions } from "./use-feed-item-entity-links";

export interface FeedItemUpdateLinksResult {
  /** Skills the installed list has vouched for. */
  validSkillIds: ReadonlySet<string>;
  /**
   * Conversations the by-id read has vouched for. A read that failed for a
   * reason other than a 404 counts: the receipt already named the
   * conversation, and the chat route handles a dead id.
   */
  validConversationIds: ReadonlySet<string>;
  /**
   * True while a read this receipt actually depends on is in flight. Scoped
   * to the receipt: an item naming nothing is never pending, whatever the
   * queries are doing.
   */
  isPending: boolean;
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Map the receipt's reads onto its link sets. Exported so the pending, 404,
 * and error cases can be asserted without mounting the queries.
 */
export function resolveUpdateLinks(args: {
  skillIds: string[];
  conversationIds: string[];
  installedSkillIds: string[] | undefined;
  isSkillsPending: boolean;
  conversations: Array<{
    conversationId: string;
    isPending: boolean;
    isError: boolean;
    exists: boolean;
  }>;
}): FeedItemUpdateLinksResult {
  const { skillIds, conversationIds, installedSkillIds, isSkillsPending } =
    args;
  let isPending = false;

  const validSkillIds = new Set<string>();
  if (skillIds.length > 0) {
    if (isSkillsPending) {
      isPending = true;
    } else {
      const installed = new Set(installedSkillIds ?? []);
      for (const skillId of skillIds) {
        if (installed.has(skillId)) {
          validSkillIds.add(skillId);
        }
      }
    }
  }

  const validConversationIds = new Set<string>();
  if (conversationIds.length > 0) {
    for (const read of args.conversations) {
      if (read.isPending) {
        isPending = true;
      } else if (read.isError || read.exists) {
        validConversationIds.add(read.conversationId);
      }
    }
  }

  return { validSkillIds, validConversationIds, isPending };
}

/**
 * Resolve the links for a receipt's `updates`, validated against the lists
 * and reads that own each target.
 *
 * `enabled` gates every fetch. The bell renders in the top bar on every route
 * and passes `false` until a detail is open, so its list view costs nothing.
 * Disabled queries stay subscribed to their caches, so a target another
 * surface already vouched for is read for free.
 */
export function useFeedItemUpdateLinks(
  updates: FeedItemUpdate[],
  assistantId: string | null | undefined,
  enabled: boolean,
): FeedItemUpdateLinksResult {
  const canFetch = enabled && Boolean(assistantId);

  // Distinct, in first-seen order, so the fan-out mounts one read per target
  // however many rewrites name it.
  const skillIds = useMemo(
    () => [...new Set(updates.map((update) => update.skillId))],
    [updates],
  );
  const conversationIds = useMemo(
    () => [
      ...new Set(
        updates.flatMap((update) =>
          update.conversationId ? [update.conversationId] : [],
        ),
      ),
    ],
    [updates],
  );

  const skillsQuery = useQuery({
    ...installedSkillsQueryOptions(assistantId ?? ""),
    enabled: canFetch && skillIds.length > 0,
  });
  const conversationQueries = useQueries({
    queries: conversationIds.map((conversationId) => ({
      ...feedItemConversationExistsQueryOptions(
        assistantId ?? "",
        conversationId,
      ),
      enabled: canFetch,
    })),
  });

  const installedSkillIds = skillsQuery.data?.skills.map((skill) => skill.id);
  const isSkillsPending = skillsQuery.isPending;
  const conversations = conversationQueries.map((query, index) => ({
    conversationId: conversationIds[index] ?? "",
    isPending: query.isPending,
    isError: query.isError,
    exists: query.data === true,
  }));

  if (!canFetch || updates.length === 0) {
    return {
      validSkillIds: EMPTY,
      validConversationIds: EMPTY,
      isPending: false,
    };
  }
  return resolveUpdateLinks({
    skillIds,
    conversationIds,
    installedSkillIds,
    isSkillsPending,
    conversations,
  });
}
