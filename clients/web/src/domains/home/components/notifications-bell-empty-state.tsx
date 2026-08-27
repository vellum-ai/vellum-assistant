import { Bell, Sparkles } from "lucide-react";
import { useNavigate } from "react-router";

import {
  EmptyStateIconWell,
  EmptyStateRecipeCard,
  EmptyStateRecipeGrid,
  EmptyStateScene,
} from "@/components/empty-state-scene";
import { useTranslation } from "@/i18n";
import { navigateToNewConversation } from "@/utils/conversation-navigation";

export interface NotificationsBellEmptyStateProps {
  /** Dismisses the panel before the recipe navigates away from it. */
  onLaunchRecipe?: () => void;
}

/**
 * The bell popover with nothing in it.
 *
 * Notifications are produced by schedules and reminders, so an empty popover
 * is not a waiting state: it means nothing has been set up yet. The scene
 * offers the schedule that fixes that, seeding a fresh conversation with the
 * prompt that asks the assistant to build it, so the notifications this
 * surface is empty of have somewhere to come from.
 *
 * Cut to what fits a popover: no description and no secondary action. The
 * panel already names itself "Notifications" above this, so a description
 * would restate the heading and a second button would compete with the
 * recipe.
 *
 * The recipe carries `Sparkles` for the same reason `PromptLaunchButton` does:
 * the control spends tokens, and the icon is how the app says so.
 */
export function NotificationsBellEmptyState({
  onLaunchRecipe,
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
      }
    />
  );
}
