import { useMemo } from "react";

import { useTranslation } from "@/i18n";
import { routes } from "@/utils/routes";
import type { FeedItem } from "@vellumai/assistant-api";
import { Button, Typography } from "@vellumai/design-library";

import {
  getFeedItemSkillId,
  getFeedItemUpdates,
  groupFeedItemUpdates,
} from "../utils";

export interface HomeUpdatesListProps {
  item: FeedItem;
  /**
   * Skills and conversations the reads in `useFeedItemUpdateLinks` have
   * vouched for. A target neither set names renders as text once validation
   * settles, so the list never links to something that is gone.
   */
  validSkillIds: ReadonlySet<string>;
  validConversationIds: ReadonlySet<string>;
  /**
   * True while those reads are in flight. Every link keeps its place and its
   * look meanwhile, with its click unwired, so the list does not reflow as
   * targets are confirmed one by one; only a target that turns out to be gone
   * changes, from link to text.
   */
  isValidationPending: boolean;
  /** Open a skill page, closing the bell. */
  onNavigate: (to: string) => void;
  /** Open a source conversation, closing the bell. */
  onGoToConversation: (conversationId: string) => void;
}

/**
 * The body of a skill-update receipt: every skill the burst rewrote, each
 * with the pass's own account of what changed and where the change came
 * from. Grouped by skill, in the order the burst first touched each one, so a
 * skill rewritten twice reads as one entry with two summaries rather than two
 * entries competing for the reader's eye.
 *
 * A receipt naming one skill, or one source conversation, offers that link in
 * the detail's footer through the same metadata a single-skill notification
 * carries, so the list leaves those out rather than showing the same button
 * twice. Only a receipt spanning several skills or several sources links
 * inline, which is the case the footer cannot serve.
 *
 * Every link is a button that closes the bell before it navigates, the way
 * the footer links do: the bell is a popover, and a router link inside it
 * would leave the popover open over the destination.
 */
export function HomeUpdatesList({
  item,
  validSkillIds,
  validConversationIds,
  isValidationPending,
  onNavigate,
  onGoToConversation,
}: HomeUpdatesListProps) {
  const { t } = useTranslation("home");
  const groups = useMemo(
    () => groupFeedItemUpdates(getFeedItemUpdates(item)),
    [item],
  );
  const footerSkillId = getFeedItemSkillId(item);
  const footerConversationId = item.conversationId ?? null;

  return (
    <div
      data-testid="home-updates-list"
      className="flex flex-col gap-[var(--app-spacing-lg)]"
    >
      {groups.map((group) => {
        const linksSkill =
          group.skillId !== footerSkillId &&
          (isValidationPending || validSkillIds.has(group.skillId));
        return (
          <section
            key={group.skillId}
            data-testid="home-updates-list-skill"
            className="flex flex-col gap-[var(--app-spacing-xs)]"
          >
            {linksSkill ? (
              <Button
                variant="link"
                className="self-start text-left text-body-medium-default [--vbtn-fg:var(--content-emphasised)]"
                onClick={
                  isValidationPending
                    ? undefined
                    : () => onNavigate(routes.skills.detail(group.skillId))
                }
              >
                {group.name}
              </Button>
            ) : (
              <Typography
                variant="body-medium-default"
                as="h3"
                className="text-[var(--content-emphasised)]"
              >
                {group.name}
              </Typography>
            )}
            <ul className="flex list-disc flex-col gap-[var(--app-spacing-xs)] pl-5">
              {group.updates.map((update, index) => {
                const conversationId = update.conversationId ?? null;
                const linksConversation =
                  conversationId !== null &&
                  conversationId !== footerConversationId &&
                  (isValidationPending ||
                    validConversationIds.has(conversationId));
                return (
                  <li
                    // Rewrites carry no id of their own, and the array order
                    // is the rewrite order, so the position is the identity.
                    key={index}
                    className="text-body-medium-default leading-normal text-[var(--content-secondary)]"
                  >
                    {update.summary}
                    {linksConversation ? (
                      <>
                        {" "}
                        <Button
                          variant="link"
                          className="text-body-small-default"
                          onClick={
                            isValidationPending
                              ? undefined
                              : () => onGoToConversation(conversationId)
                          }
                        >
                          {t("actions.goToConversation")}
                        </Button>
                      </>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
