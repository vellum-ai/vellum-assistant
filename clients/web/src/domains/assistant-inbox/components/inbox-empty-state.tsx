import { Copy, Forward, Inbox, Reply, Send, Sparkles } from "lucide-react";

import {
  EmptyStateIconWell,
  EmptyStateRecipeCard,
  EmptyStateRecipeGrid,
  EmptyStateScene,
  EmptyStateTipCard,
} from "@/components/empty-state-scene";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useTranslation } from "@/i18n";

import type { InboxFolder } from "../types";

export interface InboxEmptyStateProps {
  folder: InboxFolder;
  address: string;
  /**
   * Hands a prompt to chat so the assistant can carry a recipe out. Omit
   * and the recipes that need it are not offered, leaving the tips alone.
   */
  onLaunchPrompt?: (prompt: string) => void;
}

/**
 * A folder with no mail in it, drawn as a first-run moment rather than a
 * blank list: what fills this folder, and the three things worth doing
 * before anything has.
 *
 * Received offers the address itself as a copy control, a tip about
 * forwarding, and a recipe that has the assistant write to the user so they
 * can watch a message arrive. Sent offers the recipe that fills it, sending
 * an email through chat, and the tip that replies end up here too.
 *
 * The chat recipes carry `Sparkles` for the same reason `PromptLaunchButton`
 * does: the control spends tokens, and the icon is how the app says so.
 */
export function InboxEmptyState({
  folder,
  address,
  onLaunchPrompt,
}: InboxEmptyStateProps) {
  const { t } = useTranslation("assistant-inbox");
  const { copied, copy } = useCopyToClipboard({
    errorMessage: t("addressPill.copyFailed"),
  });

  if (folder === "sent") {
    return (
      <EmptyStateScene
        className="h-auto min-h-full justify-center"
        hero={<EmptyStateIconWell icon={Send} />}
        title={t("inboxEmptyState.sentTitle")}
        description={t("inboxEmptyState.sentBody")}
        recipes={
          <EmptyStateRecipeGrid>
            {onLaunchPrompt ? (
              <EmptyStateRecipeCard
                icon={Sparkles}
                title={t("inboxEmptyState.draftRecipeTitle")}
                description={t("inboxEmptyState.draftRecipeDescription")}
                onSelect={() =>
                  onLaunchPrompt(t("inboxEmptyState.draftRecipePrompt"))
                }
              />
            ) : null}
            <EmptyStateTipCard
              icon={Reply}
              title={t("inboxEmptyState.replyTipTitle")}
              description={t("inboxEmptyState.replyTipDescription")}
            />
          </EmptyStateRecipeGrid>
        }
      />
    );
  }

  return (
    <EmptyStateScene
      className="h-auto min-h-full justify-center"
      hero={<EmptyStateIconWell icon={Inbox} />}
      title={t("inboxEmptyState.inboxTitle")}
      description={t("inboxEmptyState.inboxBody", { address })}
      recipes={
        <EmptyStateRecipeGrid>
          <EmptyStateRecipeCard
            icon={Copy}
            title={t("inboxEmptyState.shareTipTitle")}
            description={t("inboxEmptyState.shareTipDescription", {
              address,
            })}
            meta={copied ? t("addressPill.copied") : undefined}
            onSelect={() => copy(address)}
          />
          <EmptyStateTipCard
            icon={Forward}
            title={t("inboxEmptyState.forwardTipTitle")}
            description={t("inboxEmptyState.forwardTipDescription")}
          />
          {onLaunchPrompt ? (
            <EmptyStateRecipeCard
              icon={Sparkles}
              title={t("inboxEmptyState.helloRecipeTitle")}
              description={t("inboxEmptyState.helloRecipeDescription")}
              onSelect={() =>
                onLaunchPrompt(t("inboxEmptyState.helloRecipePrompt"))
              }
            />
          ) : null}
        </EmptyStateRecipeGrid>
      }
    />
  );
}
