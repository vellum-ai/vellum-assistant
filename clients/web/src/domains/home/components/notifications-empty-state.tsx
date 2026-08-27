import { Bell, CalendarDays, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import {
  EmptyStateIconWell,
  EmptyStatePreview,
  EmptyStateRecipeCard,
  EmptyStateRecipeGrid,
  EmptyStateScene,
} from "@/components/empty-state-scene";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useTranslation } from "@/i18n";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { navigateToNewConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";
import type { FeedItem } from "@vellumai/assistant-api";
import { Button } from "@vellumai/design-library";

import { HomeRecapRow } from "../home-recap-row";

const HERO_AVATAR_SIZE = 56;

const HOUR_MS = 60 * 60 * 1000;

/** Which schedule a recipe card asks the assistant to build. */
type NotificationRecipe = "briefing" | "triage";

interface NotificationRecipeCardProps {
  recipe: NotificationRecipe;
  title: string;
  description: string;
  meta: string;
  /** Runs before navigation, for a surface that has to dismiss itself first. */
  onLaunch?: () => void;
}

/**
 * One schedule recipe. Selecting it opens a fresh conversation seeded with the
 * prompt that asks the assistant to build that schedule, so the notifications
 * this surface is empty of have somewhere to come from.
 *
 * The card carries `Sparkles` for the same reason `PromptLaunchButton` does:
 * the control spends tokens, and the icon is how the app says so.
 */
function NotificationRecipeCard({
  recipe,
  title,
  description,
  meta,
  onLaunch,
}: NotificationRecipeCardProps) {
  const { t } = useTranslation("home");
  const navigate = useNavigate();

  const handleSelect = () => {
    const prompt =
      recipe === "briefing"
        ? t("notificationRecipeCard.briefingPrompt")
        : t("notificationRecipeCard.triagePrompt");
    onLaunch?.();
    navigateToNewConversation(navigate, { prompt });
  };

  return (
    <EmptyStateRecipeCard
      icon={Sparkles}
      title={title}
      description={description}
      meta={meta}
      onSelect={handleSelect}
    />
  );
}

/**
 * The assistant's own face, so the empty feed reads as the assistant speaking
 * rather than as a missing-data placeholder. An assistant with no character
 * and no uploaded image has no face to show, and gets the bell instead.
 */
function NotificationsHero() {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const { components, traits, customImageUrl } =
    useAssistantAvatar(assistantId);

  if (!components && !customImageUrl) {
    return <EmptyStateIconWell icon={Bell} />;
  }
  return (
    <ChatAvatar
      components={components}
      traits={traits}
      customImageUrl={customImageUrl}
      size={HERO_AVATAR_SIZE}
    />
  );
}

/**
 * Three rows shaped like the notifications this feed will hold, drawn with the
 * live row component so the preview cannot drift from the real thing.
 *
 * `now` is passed in rather than read here: `Date.now()` during render is
 * impure, so the owning component parks one value for the life of the mount.
 */
function useExampleFeedItems(now: number): FeedItem[] {
  const { t } = useTranslation("home");
  return useMemo(() => {
    const at = (hoursAgo: number) =>
      new Date(now - hoursAgo * HOUR_MS).toISOString();
    return [
      {
        id: "example-briefing",
        type: "notification",
        priority: 60,
        category: "scheduling",
        sourceType: "schedule",
        title: t("notificationsEmptyState.briefingExampleTitle"),
        summary: t("notificationsEmptyState.briefingExampleSummary"),
        timestamp: at(2),
        createdAt: at(2),
        status: "seen",
      },
      {
        id: "example-triage",
        type: "notification",
        priority: 50,
        category: "email",
        sourceType: "schedule",
        title: t("notificationsEmptyState.triageExampleTitle"),
        summary: t("notificationsEmptyState.triageExampleSummary"),
        timestamp: at(5),
        createdAt: at(5),
        status: "seen",
      },
      {
        id: "example-reminder",
        type: "notification",
        priority: 40,
        category: "system",
        sourceType: "user",
        title: t("notificationsEmptyState.reminderExampleTitle"),
        summary: t("notificationsEmptyState.reminderExampleSummary"),
        timestamp: at(9),
        createdAt: at(9),
        status: "seen",
      },
    ];
  }, [now, t]);
}

const noop = () => {};

/**
 * The Activity feed with nothing in it.
 *
 * Notifications are produced by schedules and reminders, so an empty feed is
 * not a waiting state: it means nothing has been set up yet. The scene says
 * where notifications come from, shows the shape of the ones the user will
 * get, offers two schedules the assistant will build on one tap, and points
 * at the schedules page for everything else.
 */
export function NotificationsEmptyState() {
  const { t } = useTranslation("home");
  const navigate = useNavigate();
  // Stable for the life of the mount: `Date.now()` during render is impure,
  // and the example rows only need one reference point.
  const [now] = useState(() => Date.now());
  const exampleItems = useExampleFeedItems(now);

  return (
    <EmptyStateScene
      hero={<NotificationsHero />}
      title={t("notificationsEmptyState.title")}
      description={t("notificationsEmptyState.description")}
      preview={
        <EmptyStatePreview label={t("notificationsEmptyState.previewLabel")}>
          <div className="flex flex-col gap-[var(--app-spacing-sm)]">
            {exampleItems.map((item) => (
              <HomeRecapRow
                key={item.id}
                item={item}
                onSelect={noop}
                onDismiss={noop}
              />
            ))}
          </div>
        </EmptyStatePreview>
      }
      recipes={
        <EmptyStateRecipeGrid>
          <NotificationRecipeCard
            recipe="briefing"
            title={t("notificationsEmptyState.briefingRecipeTitle")}
            meta={t("notificationsEmptyState.briefingRecipeMeta")}
            description={t("notificationsEmptyState.briefingRecipeDescription")}
          />
          <NotificationRecipeCard
            recipe="triage"
            title={t("notificationsEmptyState.triageRecipeTitle")}
            meta={t("notificationsEmptyState.triageRecipeMeta")}
            description={t("notificationsEmptyState.triageRecipeDescription")}
          />
        </EmptyStateRecipeGrid>
      }
      secondaryAction={
        <Button
          variant="ghost"
          leftIcon={<CalendarDays />}
          onClick={() => {
            void navigate(routes.schedules.root);
          }}
        >
          {t("notificationsEmptyState.seeSchedules")}
        </Button>
      }
    />
  );
}

export interface NotificationsBellEmptyStateProps {
  /** Dismisses the panel before the recipe navigates away from it. */
  onLaunchRecipe?: () => void;
}

/**
 * The bell popover with nothing in it. Same premise as the page scene, cut to
 * what fits a popover: no preview, no description, and one recipe. The panel
 * already names itself "Notifications", so a description line would only
 * restate the heading above it.
 */
export function NotificationsBellEmptyState({
  onLaunchRecipe,
}: NotificationsBellEmptyStateProps) {
  const { t } = useTranslation("home");

  return (
    <EmptyStateScene
      density="compact"
      hero={<EmptyStateIconWell icon={Bell} />}
      title={t("notificationsBellEmptyState.title")}
      recipes={
        <EmptyStateRecipeGrid columns={1}>
          <NotificationRecipeCard
            recipe="briefing"
            title={t("notificationsBellEmptyState.briefingRecipeTitle")}
            meta={t("notificationsBellEmptyState.briefingRecipeMeta")}
            description={t(
              "notificationsBellEmptyState.briefingRecipeDescription",
            )}
            onLaunch={onLaunchRecipe}
          />
        </EmptyStateRecipeGrid>
      }
    />
  );
}
