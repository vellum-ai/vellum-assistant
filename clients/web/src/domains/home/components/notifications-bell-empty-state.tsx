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
  /**
   * Whether to offer the briefing recipe. The caller decides: the card is an
   * advertisement for schedules, so it is shown only to people who have none.
   */
  showBriefingRecipe?: boolean;
}

/**
 * The bell popover with nothing in it.
 *
 * An empty popover is not a waiting state, but neither is it a diagnosis:
 * permission requests, replies that arrived while the user was away, inbound
 * channel requests, credential alerts, and heartbeat failures all post here
 * without a schedule involved. So the scene says only that there is nothing
 * yet, and the copy claims nothing about why.
 *
 * Under that it may offer the schedule that would fill the panel, seeding a
 * fresh conversation with the prompt that asks the assistant to build it. That
 * offer is aimed at people who have not adopted schedules, so
 * `showBriefingRecipe` gates it, and anyone who has one gets the icon well and
 * the title alone, which is the whole scene an established user ever needs.
 *
 * Cut to what fits a popover: no description and no secondary action. The
 * panel already names itself "Notifications" above this, so a description
 * would restate the heading and a second call to action would compete with the
 * recipe.
 *
 * The recipe carries `Sparkles` for the same reason `PromptLaunchButton` does:
 * the control spends tokens, and the icon is how the app says so.
 */
export function NotificationsBellEmptyState({
  onLaunchRecipe,
  showBriefingRecipe = false,
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
        showBriefingRecipe ? (
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
        ) : undefined
      }
    />
  );
}
