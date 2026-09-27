import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";

import { Button } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import { AddressPill } from "./address-pill";
import { AssistantInboxPageFrame } from "./assistant-inbox-page-frame";

/** Quick: the line is short and the reader is waiting for their inbox. */
const TYPEWRITER_INTERVAL_MS = 24;

function useTypewriter(text: string): { typed: string; done: boolean } {
  const reduce = useReducedMotion();
  const [count, setCount] = useState(reduce ? text.length : 0);
  useEffect(() => {
    if (reduce) {
      setCount(text.length);
      return;
    }
    setCount(0);
    const id = setInterval(() => {
      setCount((current) => {
        if (current >= text.length) {
          clearInterval(id);
          return current;
        }
        return current + 1;
      });
    }, TYPEWRITER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [reduce, text]);
  return { typed: text.slice(0, count), done: count >= text.length };
}

export interface AssistantInboxSetupSuccessProps {
  assistantId: string;
  assistantName: string;
  /** The address that was just created. */
  address: string;
  /** Opens the mailbox. */
  onContinue: () => void;
  onBack?: () => void;
}

/**
 * The moment after the address is created: the page's frame with the line
 * that says it is done typed out quickly, the new address drawn as the
 * assistant, and the way into the mailbox once the line has landed. The
 * mailbox is a click away rather than a timer away, so nobody is pulled
 * off a line they were still reading.
 */
export function AssistantInboxSetupSuccess({
  assistantId,
  assistantName,
  address,
  onContinue,
  onBack,
}: AssistantInboxSetupSuccessProps) {
  const { t } = useTranslation("assistant-inbox");
  const headline = assistantName
    ? t("assistantInboxSetupSuccess.title", { name: assistantName })
    : t("assistantInboxSetupSuccess.titleNoName");
  const { typed, done } = useTypewriter(headline);

  return (
    <AssistantInboxPageFrame onBack={onBack} centered>
      <div
        data-testid="assistant-inbox-setup-success"
        className="flex max-w-[420px] flex-col items-center gap-5 text-center"
      >
        {/* The line keeps its full height while it types, so nothing under
            it moves as the words land. */}
        <h2
          className="grid text-title-medium text-[var(--content-emphasised)]"
          aria-label={headline}
        >
          <span
            aria-hidden="true"
            className="invisible col-start-1 row-start-1"
          >
            {headline}
          </span>
          <span aria-hidden="true" className="col-start-1 row-start-1">
            {typed}
            {done ? null : (
              <span className="animate-pulse text-[var(--content-tertiary)]">
                |
              </span>
            )}
          </span>
        </h2>
        <div
          className="flex flex-col items-center gap-5 transition-opacity duration-300"
          style={{ opacity: done ? 1 : 0 }}
          aria-hidden={!done}
        >
          <AddressPill assistantId={assistantId} address={address} />
          <p className="max-w-xs text-body-small-lighter text-[var(--content-secondary)]">
            {t("assistantInboxSetupSuccess.body")}
          </p>
          <Button variant="primary" onClick={onContinue} disabled={!done}>
            {t("assistantInboxSetupSuccess.openInbox")}
          </Button>
        </div>
      </div>
    </AssistantInboxPageFrame>
  );
}
