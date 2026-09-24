import { MessageSquarePlus, Trash2, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import { Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import type { InboxEmail } from "../types";

export interface EmailSelectionBarProps {
  /** The checked messages, across both folders. */
  emails: InboxEmail[];
  onClear: () => void;
  /** Absent when nothing will act on it; the action is then not drawn. */
  onStartChat?: (emails: InboxEmail[]) => void;
  onDelete?: (emails: InboxEmail[]) => void;
}

/**
 * The menu that rises from the bottom of the mailbox while messages are
 * checked: how many, and what can be done with them. It floats over the two
 * cards rather than sitting in the list, since the list card is too narrow
 * for two actions and a count, and the actions concern the whole selection,
 * which can span both folders. Where it does, the count says how many came
 * from each, because the two are not interchangeable to the assistant.
 */
export function EmailSelectionBar({
  emails,
  onClear,
  onStartChat,
  onDelete,
}: EmailSelectionBarProps) {
  const { t } = useTranslation("assistant-inbox");
  const reducedMotion = useReducedMotion();
  const received = emails.filter((email) => email.direction === "inbound");
  const sent = emails.length - received.length;
  const mixed = received.length > 0 && sent > 0;

  return (
    <AnimatePresence>
      {emails.length > 0 ? (
        <motion.div
          key="email-selection-bar"
          role="toolbar"
          aria-label={t("emailSelectionBar.ariaLabel")}
          data-testid="email-selection-bar"
          initial={reducedMotion ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 16 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="pointer-events-auto flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-lift)] py-2 pl-4 pr-2 shadow-[0_8px_32px_rgba(0,0,0,0.14)]"
        >
          <div className="flex min-w-0 flex-col">
            <span className="whitespace-nowrap text-body-medium-default text-[var(--content-emphasised)]">
              {t("emailSelectionBar.count", { count: emails.length })}
            </span>
            {mixed ? (
              <span className="whitespace-nowrap text-label-small-default text-[var(--content-tertiary)]">
                {t("emailSelectionBar.mixed", {
                  received: received.length,
                  sent,
                })}
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {onStartChat ? (
              <Button
                variant="primary"
                leftIcon={<MessageSquarePlus />}
                onClick={() => onStartChat(emails)}
              >
                {t("emailSelectionBar.startChat")}
              </Button>
            ) : null}
            {onDelete ? (
              <Button
                variant="dangerGhost"
                leftIcon={<Trash2 />}
                onClick={() => onDelete(emails)}
              >
                {t("emailSelectionBar.delete")}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              iconOnly={<X />}
              onClick={onClear}
              aria-label={t("emailSelectionBar.clear")}
            />
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
