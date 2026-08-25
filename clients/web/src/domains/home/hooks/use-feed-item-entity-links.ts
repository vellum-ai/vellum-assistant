/**
 * Resolves the "go look at the thing this notification is about" links for one
 * feed item.
 *
 * A notification names an entity by putting its id in the feed item's
 * free-form `metadata` bag (`scheduleId` for a scheduled run, `skillId` for a
 * background skill update). Turning one of those ids into a button needs three
 * things the id itself does not carry: the route to build, the copy and icon to
 * render, and the list query that vouches the target still exists. That per
 * entity knowledge lives here, once, so the two surfaces that render a feed
 * item's detail (the Activity page's panel and the notifications bell) offer
 * the same links on the same items without either one growing a second copy of
 * the validation logic.
 *
 * Adding a linkable entity is one entry in `ENTITY_LINKS` plus its query below.
 *
 * Validation matters because a notification outlives what it points at: a
 * schedule can be deleted and a skill removed long after the run that
 * announced it. An id whose list has resolved without it drops out rather than
 * rendering a link to a tombstone.
 */
import { useQuery } from "@tanstack/react-query";
import type { ParseKeys } from "@/i18n";
import type { LucideIcon } from "lucide-react";
import { Brain, Calendar } from "lucide-react";
import { useMemo } from "react";

import { skillsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { routes } from "@/utils/routes";
import { schedulesListQueryOptions } from "@/utils/schedules";
import type { FeedItem } from "@vellumai/assistant-api";

import { getFeedItemScheduleId, getFeedItemSkillId } from "../utils";

/** One resolved link out of a feed item, ready to render as a button. */
export interface FeedItemEntityLink {
  /** Entity kind. Stable across renders, so it doubles as the React key. */
  kind: "schedule" | "skill";
  /**
   * Key into the `home` namespace, not the copy itself. This module is not a
   * component, so it cannot hold a `useTranslation` binding; resolving the key
   * at the render site is also what keeps a label live across a language
   * change rather than freezing whatever was current when the link resolved.
   *
   * Typed as `ParseKeys<"home">` rather than `string` so the catalog stays the
   * authority: a key with no entry in `locales/en/home.json` fails to compile
   * here instead of rendering the raw key at the user.
   */
  labelKey: ParseKeys<"home">;
  icon: LucideIcon;
  /** App path to navigate to. Built here so callers stay route-agnostic. */
  to: string;
}

export interface FeedItemEntityLinksResult {
  links: FeedItemEntityLink[];
  /**
   * True while a list this item's links actually depend on is still loading.
   * Scoped to the item: an item naming no entity is never pending, whatever
   * the queries are doing.
   */
  isPending: boolean;
}

const ENTITY_LINKS = [
  {
    kind: "schedule",
    labelKey: "actions.viewSchedule",
    icon: Calendar,
    readId: getFeedItemScheduleId,
    toDetail: (id: string) => routes.schedules.detail(id),
  },
  {
    kind: "skill",
    labelKey: "actions.viewSkill",
    icon: Brain,
    readId: getFeedItemSkillId,
    toDetail: (id: string) => routes.skills.detail(id),
  },
] as const satisfies ReadonlyArray<{
  kind: FeedItemEntityLink["kind"];
  labelKey: FeedItemEntityLink["labelKey"];
  icon: LucideIcon;
  readId: (item: FeedItem | null) => string | null;
  toDetail: (id: string) => string;
}>;

/**
 * Resolve the entity links for `item`, validated against the lists that own
 * each entity.
 *
 * `enabled` gates both list fetches. The bell renders in the top bar on every
 * route and passes `false` until a detail is open, so its list view costs
 * nothing; the Activity page holds them open. Disabled queries stay subscribed
 * to their caches, so a list another surface already loaded is read for free.
 *
 * A candidate link whose list is still loading is returned anyway, marked by
 * `isPending`, so a caller can hold the space it will occupy rather than
 * letting the footer change shape underneath a cursor. Callers with warm
 * caches can ignore `isPending` and render `links` directly.
 */
export function useFeedItemEntityLinks(
  item: FeedItem | null,
  assistantId: string | null | undefined,
  enabled: boolean,
): FeedItemEntityLinksResult {
  const scheduleQuery = useQuery({
    ...schedulesListQueryOptions(assistantId ?? undefined),
    enabled,
  });
  // Installed skills only. `include: "catalog"` would pull the whole remote
  // skills.sh catalog to answer a local existence check, and a managed skill
  // (the only kind a skill-update notification names) is always `installed`.
  // Same key as the identity stats card's read, so the two share one entry.
  const skillQuery = useQuery({
    ...skillsGetOptions({
      path: { assistant_id: assistantId ?? "" },
      query: { kind: "installed" },
    }),
    enabled: enabled && Boolean(assistantId),
  });

  const schedules = scheduleQuery.data;
  const skills = skillQuery.data;

  return useMemo(() => {
    // No assistant, no lists to validate against, so nothing is linkable. The
    // skills query is disabled in that state and would otherwise report
    // `isPending` forever, holding a link's box open on a link that can never
    // arrive.
    if (!assistantId) {
      return { links: [], isPending: false };
    }

    // Joins each descriptor to the list that owns it. An item names at most
    // one entity of a kind, so membership is tested directly against the list
    // rather than indexed first: building a Set per kind would cost more than
    // the lookups it serves, on every recompute, for lists this size.
    const listByKind: Record<
      FeedItemEntityLink["kind"],
      { items?: { id: string }[]; isPending: boolean }
    > = {
      schedule: { items: schedules, isPending: scheduleQuery.isPending },
      skill: { items: skills?.skills, isPending: skillQuery.isPending },
    };

    const links: FeedItemEntityLink[] = [];
    let isPending = false;

    for (const entity of ENTITY_LINKS) {
      const id = entity.readId(item);
      if (id === null) {
        continue;
      }
      const list = listByKind[entity.kind];
      if (list.isPending) {
        isPending = true;
      } else if (!list.items?.some((candidate) => candidate.id === id)) {
        continue;
      }
      links.push({
        kind: entity.kind,
        labelKey: entity.labelKey,
        icon: entity.icon,
        to: entity.toDetail(id),
      });
    }

    return { links, isPending };
  }, [
    assistantId,
    item,
    schedules,
    skills,
    scheduleQuery.isPending,
    skillQuery.isPending,
  ]);
}
