import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

import { Button, cn } from "@vellumai/design-library";

import { useTranslation } from "@/i18n";

import { AssistantInboxShell } from "./assistant-inbox-shell";

export interface AssistantInboxPageFrameProps {
  /** Leaves the page. Without it no back control is drawn. */
  onBack?: () => void;
  /** Centre the body's content in the panel rather than starting it at the top. */
  centered?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * The inbox's page states that are not the mailbox (setup, the upgrade
 * pitch, the moment after setup), drawn as the design's overlay panel: one
 * bordered, rounded panel on the page ground holding a header row with the
 * way back and the page's name, and the body below on the same surface.
 */
export function AssistantInboxPageFrame({
  onBack,
  centered = false,
  children,
  className,
}: AssistantInboxPageFrameProps) {
  const { t } = useTranslation("assistant-inbox");
  return (
    <AssistantInboxShell>
      <div
        className={cn(
          "m-2 flex min-h-0 flex-1 flex-col gap-4 rounded-[12px] border border-[var(--border-base)] bg-[var(--surface-lift)] px-6 py-5",
          className,
        )}
      >
        <header className="flex items-center gap-3">
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
            "flex min-h-0 flex-1 flex-col overflow-y-auto rounded-lg",
            centered && "items-center justify-center",
          )}
        >
          {children}
        </div>
      </div>
    </AssistantInboxShell>
  );
}
