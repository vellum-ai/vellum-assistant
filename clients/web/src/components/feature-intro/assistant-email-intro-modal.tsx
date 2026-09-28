import { Zap } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import {
  AssistantInboxPerks,
  AssistantInboxUpgradeBody,
} from "@/domains/assistant-inbox/components/assistant-inbox-upgrade-body";
import { useInboxPitchCopy } from "@/domains/assistant-inbox/hooks/use-inbox-pitch-copy";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";

import { FeatureIntroModal } from "./feature-intro-modal";

/** The character's size in the hero; the mailbox sits on its lower corner. */
const HERO_AVATAR_SIZE = 100;

export interface AssistantEmailIntroModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whose inbox it would be; the hero is their character. */
  assistantId: string;
  /** Empty when the assistant has no name yet; the copy then says "your assistant". */
  assistantName: string;
  rootDomain: string;
  /**
   * The org's plan has no managed email. The pitch then ends in the plan
   * notice with the way to the plans and the upgrade; otherwise it ends in
   * the way to set the address up.
   */
  locked: boolean;
  onUpgrade: () => void;
  onSeePlans: () => void;
  onSetUp: () => void;
}

/**
 * The one-time intro for Assistant Email: the assistant's character with a
 * mailbox, the inbox pitch's title and line, its three perks, and either
 * the design's plan notice with Plans / Upgrade to Super (a plan without
 * email) or the way into setup (a plan with it). The copy and the perk
 * rows are the inbox's own, so the intro and the inbox's upgrade page never
 * disagree about what the feature is.
 */
export function AssistantEmailIntroModal({
  open,
  onOpenChange,
  assistantId,
  assistantName,
  rootDomain,
  locked,
  onUpgrade,
  onSeePlans,
  onSetUp,
}: AssistantEmailIntroModalProps) {
  const { t } = useTranslation();
  const { title, subtitle } = useInboxPitchCopy(assistantName);
  const { components, traits, customImageUrl } =
    useAssistantAvatar(assistantId);

  return (
    <FeatureIntroModal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={subtitle}
      hero={
        <div
          className="relative"
          style={{ width: HERO_AVATAR_SIZE + 13, height: HERO_AVATAR_SIZE }}
          data-testid="assistant-email-intro-hero"
        >
          <ChatAvatar
            components={components}
            traits={traits}
            customImageUrl={customImageUrl}
            size={HERO_AVATAR_SIZE}
          />
          <span
            aria-hidden="true"
            className="absolute right-0 bottom-0 leading-none"
            style={{ fontSize: "40px" }}
          >
            📭
          </span>
        </div>
      }
    >
      {locked ? (
        <AssistantInboxUpgradeBody
          assistantId={assistantId}
          assistantName={assistantName}
          handle=""
          rootDomain={rootDomain}
          onUpgrade={onUpgrade}
          onSeePlans={onSeePlans}
          align="center"
        />
      ) : (
        <div className="flex w-full max-w-[360px] flex-col items-center gap-6">
          <AssistantInboxPerks
            assistantName={assistantName}
            rootDomain={rootDomain}
          />
          <Button variant="primary" leftIcon={<Zap />} onClick={onSetUp}>
            {t("assistantEmailIntroModal.setUp")}
          </Button>
        </div>
      )}
    </FeatureIntroModal>
  );
}
