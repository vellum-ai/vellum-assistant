/**
 * The staged external-channel reference, pinned above the Vellum composer.
 *
 * Sits in the same stack as `StagedQuotesStrip` and reads the same way: a
 * compact quoted preview with a single X that takes it back off. One slot, so
 * there is no list to scroll and no ordering to explain.
 *
 * Self-sources from the store and renders nothing when empty, so hosts mount
 * it unconditionally.
 */

import { X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { Button, Card, Typography } from "@vellumai/design-library";
import {
  quoteBlockquoteAccentClassName,
  quoteBlockquoteClassName,
  quoteBlockquoteContentClassName,
} from "@vellumai/design-library/components/markdown-message";

import { useChannelReferenceStore } from "@/domains/chat/channel-sidecar/channel-reference-store";
import { useTranslation } from "@/i18n";
import { ChannelIcon } from "@/utils/channel-presentation";

export function ChannelReferenceChip() {
  const { t } = useTranslation("chat");
  const reference = useChannelReferenceStore.use.reference();
  const clearReference = useChannelReferenceStore.use.clearReference();
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence>
      {reference ? (
        <motion.div
          layout
          initial={
            reduceMotion ? false : { opacity: 0, height: 0, scale: 0.98 }
          }
          animate={{ opacity: 1, height: "auto", scale: 1 }}
          exit={
            reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0, scale: 0.98 }
          }
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="mb-2 overflow-hidden"
        >
          <Card.Root
            padding="sm"
            bordered
            className="bg-[var(--surface-lift)]"
            data-testid="channel-reference-chip"
          >
            <Card.Body padding="md" className="relative flex flex-col gap-2 pr-8">
              <div className="flex min-w-0 items-center gap-1.5">
                <ChannelIcon
                  channelId={reference.channelId}
                  className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)]"
                />
                <Typography
                  as="span"
                  variant="body-small-emphasised"
                  className="min-w-0 truncate text-[var(--content-secondary)]"
                >
                  {reference.senderName
                    ? t("channelReferenceChip.headingWithSender", {
                        channel: reference.channelLabel,
                        sender: reference.senderName,
                      })
                    : t("channelReferenceChip.heading", {
                        channel: reference.channelLabel,
                      })}
                </Typography>
              </div>
              <Typography
                as="div"
                variant="body-small-lighter"
                className={`${quoteBlockquoteClassName} mb-0`}
              >
                <span
                  aria-hidden="true"
                  className={quoteBlockquoteAccentClassName}
                />
                <span
                  className={`${quoteBlockquoteContentClassName} line-clamp-3 break-words`}
                >
                  {reference.snippet || t("channelTranscriptPanel.noText")}
                </span>
              </Typography>
              <Button
                variant="ghost"
                size="compact"
                iconOnly={<X />}
                expandOnMobile={false}
                onClick={clearReference}
                className="absolute right-1 top-1 shrink-0"
                aria-label={t("channelReferenceChip.removeAria")}
              />
            </Card.Body>
          </Card.Root>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
