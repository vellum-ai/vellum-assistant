import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

import { Button, cn } from "@vellumai/design-library";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";

import { AssistantInboxShell } from "./assistant-inbox-shell";

export interface AssistantInboxPageFrameProps {
  /** Leaves the page. Without it no back control is drawn. */
  onBack?: () => void;
  /** Centre the body's content in the panel rather than starting it at the top. */
  centered?: boolean;
  /**
   * Draw this assistant's character peeking over the panel's foot, the way
   * the design's setup screen has it. Nothing is drawn for an assistant
   * with a custom image instead of a character.
   */
  peekAssistantId?: string;
  children: ReactNode;
  className?: string;
}

/** The peeking character's size; a little over half of it shows. */
const PEEK_SIZE = 260;

/**
 * The inbox's page states that are not the mailbox (setup, the upgrade
 * pitch, the moment after setup), drawn as the design's overlay panel: one
 * bordered, rounded panel on the page ground holding a header row with the
 * way back and the page's name, and the body below on the same surface.
 */
export function AssistantInboxPageFrame({
  onBack,
  centered = false,
  peekAssistantId,
  children,
  className,
}: AssistantInboxPageFrameProps) {
  const { t } = useTranslation("assistant-inbox");
  const { components, traits } = useAssistantAvatar(peekAssistantId ?? null);
  const peeks = peekAssistantId !== undefined && components && traits;
  return (
    <AssistantInboxShell>
      <div
        className={cn(
          "relative m-2 flex min-h-0 flex-1 flex-col gap-4 overflow-hidden rounded-[12px] border border-[var(--border-base)] bg-[var(--surface-lift)] px-6 py-5",
          className,
        )}
      >
        {peeks ? (
          /* Behind the content, cut by the panel's edge so only the eyes
             and the crown of the character show. */
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-[14%] z-0"
            style={{
              width: PEEK_SIZE,
              height: PEEK_SIZE,
              bottom: -Math.round(PEEK_SIZE * 0.42),
            }}
          >
            <ChatAvatar
              components={components}
              traits={traits}
              customImageUrl={null}
              size={PEEK_SIZE}
            />
          </div>
        ) : null}
        <header className="relative z-10 flex items-center gap-3">
          {onBack ? (
            <Button
              variant="outlined"
              iconOnly={<ArrowLeft />}
              onClick={onBack}
              aria-label={t("assistantInboxPageFrame.back")}
            />
          ) : null}
          <h1 className="min-w-0 truncate text-title-large text-[var(--content-emphasised)]">
            {t("assistantInboxPageFrame.title")}
          </h1>
        </header>
        <div
          className={cn(
            "relative z-10 flex min-h-0 flex-1 flex-col overflow-y-auto rounded-lg",
            centered && "items-center justify-center",
          )}
        >
          {children}
        </div>
      </div>
    </AssistantInboxShell>
  );
}
