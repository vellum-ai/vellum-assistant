import {
    ArrowUp,
    Ellipsis,
    Globe,
    Pin,
    PinOff,
    Trash2,
} from "lucide-react";
import { type MouseEvent, useCallback, useState } from "react";

import { AppPreviewThumbnail } from "@/components/app-card";
import { SwipeActionReveal } from "@/components/swipe-action-reveal";
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { AppSummary } from "@/types/app-types";
import { getCachedAppHtml } from "@/utils/app-html-cache";
import { formatFriendlyDate } from "@/utils/format-date";
import { cn } from "@/utils/misc";
import { shareApp } from "@/utils/share-app";
import { isPointerCoarse } from "@/utils/pointer";
import type { SwipeAction } from "@/hooks/use-swipe-to-reveal";
import {
    BottomSheet,
    Button,
    Menu,
    PanelItem,
    toast,
} from "@vellumai/design-library";

interface LibraryAppCardProps {
  app: AppSummary;
  assistantId: string;
  isPinned: boolean;
  onOpen: (appId: string) => void;
  onPin: (app: AppSummary) => void;
  onDelete?: (app: AppSummary) => void;
  onDeploy?: () => void;
  justImported?: boolean;
  onAnimationEnd?: () => void;
}

export function LibraryAppCard({
  app,
  assistantId,
  isPinned,
  onOpen,
  onPin,
  onDelete,
  onDeploy,
  justImported,
  onAnimationEnd,
}: LibraryAppCardProps) {
  const [isSharing, setIsSharing] = useState(false);
  const loadHtml = useCallback(
    () => getCachedAppHtml(assistantId, app.id),
    [assistantId, app.id],
  );
  const handleShare = useCallback(async () => {
    if (isSharing) return;
    setIsSharing(true);
    try {
      await shareApp(assistantId, app.id, app.name);
      toast.success("App exported", { description: `${app.name}.vellum` });
    } catch (err) {
      toast.error("Failed to share app", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsSharing(false);
    }
  }, [assistantId, app.id, app.name, isSharing]);

  const [menuOpen, setMenuOpen] = useState(false);
  const isMobile = useIsMobile();

  // Leading swipe actions are intentionally omitted. On mobile chat-side
  // routes, ChatLayout enables a document-level drawer edge swipe
  // (useEdgeSwipe) that captures rightward swipes starting in the left 50vw.
  // A leading swipe-right on library cards in that zone would conflict with
  // the drawer-open gesture. Pin/Unpin is moved to the trailing side
  // (swipe-left) alongside Delete so both actions remain available without
  // the gesture conflict.
  const trailingActions: SwipeAction[] = isPointerCoarse()
    ? [
        {
          id: "pin",
          label: isPinned ? "Unpin" : "Pin",
          icon: isPinned ? PinOff : Pin,
          onSelect: () => onPin(app),
        },
        ...(onDelete
          ? [
              {
                id: "delete",
                label: "Delete",
                icon: Trash2,
                variant: "destructive" as const,
                onSelect: () => onDelete(app),
              },
            ]
          : []),
      ]
    : [];

  return (
    <SwipeActionReveal
      trailingActions={trailingActions}
      className="rounded-xl"
    >
      <div
        className={cn(
          "group relative flex flex-col gap-2",
          justImported && "animate-[card-entrance_400ms_ease-out]",
        )}
        onAnimationEnd={justImported ? onAnimationEnd : undefined}
      >
        <button
          type="button"
          onClick={() => onOpen(app.id)}
          className={cn(
            "relative w-full cursor-pointer overflow-hidden rounded-xl",
            "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
          )}
        >
          <AppPreviewThumbnail
            name={app.name}
            icon={app.icon}
            loadHtml={loadHtml}
          />
        </button>

        <div
          className={cn(
            "absolute right-2 top-2 z-20 transition-opacity",
            "max-md:opacity-100",
            "md:group-hover:opacity-100 md:group-focus-within:opacity-100",
            menuOpen ? "opacity-100" : "md:opacity-0",
          )}
        >
          <LibraryAppCardActionsMenu
            appName={app.name}
            isPinned={isPinned}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onPin={() => onPin(app)}
            onDelete={onDelete ? () => onDelete(app) : undefined}
            onShare={handleShare}
            onDeploy={onDeploy}
            isMobile={isMobile}
          />
        </div>

        <button
          type="button"
          onClick={() => onOpen(app.id)}
          className="flex cursor-pointer flex-col gap-0.5 px-0.5 text-left outline-none"
        >
          <span className="truncate text-body-large-default text-[color:var(--content-emphasised)]">
            {app.name}
          </span>
          <span className="text-body-small-default text-[color:var(--content-tertiary)]">
            {formatFriendlyDate(new Date(app.createdAt))}
          </span>
        </button>
      </div>
    </SwipeActionReveal>
  );
}

// ---------------------------------------------------------------------------
// Actions menu (desktop dropdown + mobile bottom sheet)
// ---------------------------------------------------------------------------

export interface LibraryAppCardActionsMenuProps {
  appName: string;
  isPinned: boolean;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onPin: () => void;
  onDelete?: () => void;
  onShare?: () => void;
  onDeploy?: () => void;
  isMobile: boolean;
}

export function LibraryAppCardActionsMenu({
  appName,
  isPinned,
  open,
  onOpenChange,
  onPin,
  onDelete,
  onShare,
  onDeploy,
  isMobile,
}: LibraryAppCardActionsMenuProps) {
  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={onOpenChange}>
        <BottomSheet.Trigger asChild>
          <Button
            variant="primary"
            size="compact"
            iconOnly={<Ellipsis />}
            aria-label="App actions"
            onClick={(e: MouseEvent) => e.stopPropagation()}
          />
        </BottomSheet.Trigger>
        <BottomSheet.Content>
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>{appName}</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">
            <PanelItem
              icon={isPinned ? PinOff : Pin}
              label={isPinned ? "Unpin" : "Pin"}
              onSelect={() => {
                onOpenChange(false);
                onPin();
              }}
            />
            {onShare ? (
              <PanelItem
                icon={ArrowUp}
                label={
                  <span className="flex flex-col gap-0.5 overflow-visible whitespace-normal">
                    <span>Share</span>
                    <span className="text-body-small-default text-[var(--content-tertiary)]">
                      Export as .vellum file
                    </span>
                  </span>
                }
                onSelect={() => {
                  onOpenChange(false);
                  onShare();
                }}
              />
            ) : null}
            {onDeploy ? (
              <PanelItem
                icon={Globe}
                label={
                  <span className="flex flex-col gap-0.5 overflow-visible whitespace-normal">
                    <span>Deploy to Vercel</span>
                    <span className="text-body-small-default text-[var(--content-tertiary)]">
                      Publish as a static page
                    </span>
                  </span>
                }
                onSelect={() => {
                  onOpenChange(false);
                  onDeploy();
                }}
              />
            ) : null}
            {onDelete ? (
              <PanelItem
                icon={Trash2}
                label="Delete"
                onSelect={() => {
                  onOpenChange(false);
                  onDelete();
                }}
              />
            ) : null}
          </BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger asChild>
        <Button
          variant="primary"
          size="compact"
          iconOnly={<Ellipsis />}
          aria-label="App actions"
          onClick={(e: MouseEvent) => e.stopPropagation()}
        />
      </Menu.Trigger>
      <Menu.Content align="end" sideOffset={4}>
        <Menu.Item
          leftIcon={isPinned ? <PinOff size={14} /> : <Pin size={14} />}
          onSelect={() => onPin()}
          className="whitespace-nowrap"
        >
          {isPinned ? "Unpin" : "Pin"}
        </Menu.Item>
        {onShare ? (
          <Menu.Item
            leftIcon={<ArrowUp size={14} />}
            onSelect={() => onShare()}
            className="whitespace-nowrap"
          >
            Share
          </Menu.Item>
        ) : null}
        {onDeploy ? (
          <Menu.Item
            leftIcon={<Globe size={14} />}
            onSelect={() => onDeploy()}
            className="whitespace-nowrap"
          >
            Deploy to Vercel
          </Menu.Item>
        ) : null}
        {onDelete ? (
          <Menu.Item
            leftIcon={<Trash2 size={14} className="text-red-600" />}
            onSelect={() => onDelete()}
            className="whitespace-nowrap text-red-600 data-[highlighted]:text-red-700"
          >
            Delete
          </Menu.Item>
        ) : null}
      </Menu.Content>
    </Menu.Root>
  );
}
