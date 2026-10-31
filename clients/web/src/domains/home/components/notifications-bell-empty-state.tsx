import { Bell, Sparkles } from "lucide-react";
import { useNavigate } from "react-router";

import {
  EmptyStateIconWell,
  EmptyStateRecipeCard,
  EmptyStateRecipeGrid,
  EmptyStateScene,
} from "@/components/empty-state-scene";
import { NativeAppReminderNudge } from "@/components/nudges/native-app-reminder-nudge";
import { useTranslation } from "@/i18n";
import { navigateToNewConversation } from "@/utils/conversation-navigation";

export interface NotificationsBellEmptyStateProps {
  /** Dismisses the panel before the recipe navigates away from it. */
  onLaunchRecipe?: () => void;
  /**
   * Whether to offer the briefing recipe. The caller decides: the card is an
   * advertisement for schedules, so it is shown only to people who have none.
   */
  showBriefingRecipe?: boolean;
  showNativeAppNudge?: boolean;
}

/** Empty notifications with optional schedule and phone app recommendations. */
export function NotificationsBellEmptyState({
  onLaunchRecipe,
  showBriefingRecipe = false,
  showNativeAppNudge = false,
}: NotificationsBellEmptyStateProps) {
  const { t } = useTranslation("home");
  const navigate = useNavigate();

  const handleSelectBriefing = () => {
    onLaunchRecipe?.();
    navigateToNewConversation(navigate, {
      prompt: t("notificationsBellEmptyState.briefingRecipePrompt"),
    });
  };

  return (
    <EmptyStateScene
      hero={<EmptyStateIconWell icon={Bell} />}
      title={t("notificationsBellEmptyState.title")}
      recipes={
        <>
          {showBriefingRecipe ? (
            <EmptyStateRecipeGrid>
              <EmptyStateRecipeCard
                icon={Sparkles}
                title={t("notificationsBellEmptyState.briefingRecipeTitle")}
                meta={t("notificationsBellEmptyState.briefingRecipeMeta")}
                description={t(
                  "notificationsBellEmptyState.briefingRecipeDescription",
                )}
                onSelect={handleSelectBriefing}
              />
            </EmptyStateRecipeGrid>
          ) : null}
          {showNativeAppNudge ? (
            <NativeAppReminderNudge surface="notifications-empty" />
          ) : null}
        </>
      }
    />
  );
}
