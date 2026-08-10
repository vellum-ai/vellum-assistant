import {
  ArrowUp,
  Ellipsis,
  Globe,
  Link2,
  Pin,
  PinOff,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { type MouseEvent, useCallback, useState } from "react";

import { AppPreviewThumbnail } from "@/components/app-card";
import { SwipeActionReveal } from "@/components/swipe-action-reveal";
import {
  copyDeployedAppLink,
  useAppDeployment,
} from "@/hooks/use-app-deployment";
import { useTouchMobile } from "@/hooks/use-touch-mobile";
import { type AppSummary, isReadOnlyApp } from "@/types/app-types";
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

import { useTranslation } from "@/i18n";

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
  const { t } = useTranslation("library");
  const [isSharing, setIsSharing] = useState(false);
  // Plugin-bundled apps are read-only: the daemon rejects delete/share/deploy
  // against them, so drop those actions here rather than render buttons that
  // error. Pin/Open stay — pinning is a client-only preference and opening is
  // always allowed.
  const readOnly = isReadOnlyApp(app.origin);
  const deleteAction = readOnly ? undefined : onDelete;
  const deployAction = readOnly ? undefined : onDeploy;
  const loadHtml = useCallback(
    () => getCachedAppHtml(assistantId, app.id),
    [assistantId, app.id],
  );
  const handleShare = useCallback(async () => {
    if (isSharing) {
      return;
    }
    setIsSharing(true);
    try {
      await shareApp(assistantId, app.id, app.name);
      toast.success(t("libraryAppCard.exported"), {
        description: `${app.name}.vellum`,
      });
    } catch (err) {
      toast.error(t("libraryAppCard.shareFailed"), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsSharing(false);
    }
  }, [assistantId, app.id, app.name, isSharing, t]);

  const [menuOpen, setMenuOpen] = useState(false);

  // The library renders one card per app, so the deployment status is fetched
  // lazily rather than N-at-a-time on mount: the first hover (or menu open)
  // arms it, and it stays armed so the answer is already in hand when the
  // menu is reopened, including right after a deploy.
  const [deployStatusArmed, setDeployStatusArmed] = useState(false);
  const armDeployStatus = useCallback(() => setDeployStatusArmed(true), []);
  const { deployedUrl } = useAppDeployment(assistantId, app.id, {
    enabled: deployStatusArmed && deployAction != null,
  });
  const handleCopyDeployedLink = useCallback(() => {
    if (deployedUrl != null) {
      copyDeployedAppLink(deployedUrl);
    }
  }, [deployedUrl]);

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
        ...(deleteAction
          ? [
              {
                id: "delete",
                label: "Delete",
                icon: Trash2,
                variant: "destructive" as const,
                onSelect: () => deleteAction(app),
              },
            ]
          : []),
      ]
    : [];

  return (
    <SwipeActionReveal trailingActions={trailingActions} className="rounded-xl">
      <div
        className={cn(
          "group relative flex flex-col gap-2",
          justImported && "animate-[card-entrance_400ms_ease-out]",
        )}
        onAnimationEnd={justImported ? onAnimationEnd : undefined}
        onPointerEnter={armDeployStatus}
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
            onOpenChange={(next) => {
              if (next) {
                armDeployStatus();
              }
              setMenuOpen(next);
            }}
            onPin={() => onPin(app)}
            onDelete={deleteAction ? () => deleteAction(app) : undefined}
            onShare={readOnly ? undefined : handleShare}
            onDeploy={deployAction}
            deployedUrl={deployedUrl}
            onCopyDeployedLink={handleCopyDeployedLink}
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
// Actions menu (anchored dropdown, or a bottom sheet on touch)
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
  /**
   * Live URL of the app's active Vercel deployment, when it has one. Swaps
   * the deploy entry for a "Deployed to Vercel" entry that hands back the
   * link, plus an explicit Redeploy.
   */
  deployedUrl?: string | null;
  /** Invoked by the deployed-state entry; copies the link and shows it. */
  onCopyDeployedLink?: () => void;
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
  deployedUrl,
  onCopyDeployedLink,
}: LibraryAppCardActionsMenuProps) {
  const { t } = useTranslation("library");
  const isTouchMobile = useTouchMobile();
  // Only treated as deployed when the caller can also hand the link back.
  // Otherwise the entry would report a deployment it can't reach.
  const isDeployed =
    deployedUrl != null && deployedUrl !== "" && onCopyDeployedLink != null;
  if (isTouchMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={onOpenChange}>
        <BottomSheet.Trigger asChild>
          <Button
            variant="primary"
            size="compact"
            iconOnly={<Ellipsis />}
            aria-label={t("libraryAppCard.actionsAria")}
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
              label={
                isPinned ? t("libraryAppCard.unpin") : t("libraryAppCard.pin")
              }
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
                    <span>{t("libraryAppCard.share")}</span>
                    <span className="text-body-small-default text-[var(--content-tertiary)]">
                      {t("libraryAppCard.shareSub")}
                    </span>
                  </span>
                }
                onSelect={() => {
                  onOpenChange(false);
                  onShare();
                }}
              />
            ) : null}
            {onDeploy && isDeployed ? (
              <>
                <PanelItem
                  icon={Link2}
                  label={
                    <span className="flex flex-col gap-0.5 overflow-visible whitespace-normal">
                      <span>{t("libraryAppCard.deployed")}</span>
                      <span className="break-all text-body-small-default text-[var(--content-tertiary)]">
                        {deployedUrl}
                      </span>
                    </span>
                  }
                  onSelect={() => {
                    onOpenChange(false);
                    onCopyDeployedLink?.();
                  }}
                />
                <PanelItem
                  icon={RefreshCw}
                  label={
                    <span className="flex flex-col gap-0.5 overflow-visible whitespace-normal">
                      <span>{t("libraryAppCard.redeploy")}</span>
                      <span className="text-body-small-default text-[var(--content-tertiary)]">
                        {t("libraryAppCard.redeploySub")}
                      </span>
                    </span>
                  }
                  onSelect={() => {
                    onOpenChange(false);
                    onDeploy();
                  }}
                />
              </>
            ) : onDeploy ? (
              <PanelItem
                icon={Globe}
                label={
                  <span className="flex flex-col gap-0.5 overflow-visible whitespace-normal">
                    <span>{t("libraryAppCard.deploy")}</span>
                    <span className="text-body-small-default text-[var(--content-tertiary)]">
                      {t("libraryAppCard.deploySub")}
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
                label={t("libraryAppCard.delete")}
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
          aria-label={t("libraryAppCard.actionsAria")}
          onClick={(e: MouseEvent) => e.stopPropagation()}
        />
      </Menu.Trigger>
      <Menu.Content align="end" sideOffset={4}>
        <Menu.Item
          leftIcon={isPinned ? <PinOff size={14} /> : <Pin size={14} />}
          onSelect={() => onPin()}
          className="whitespace-nowrap"
        >
          {isPinned ? t("libraryAppCard.unpin") : t("libraryAppCard.pin")}
        </Menu.Item>
        {onShare ? (
          <Menu.Item
            leftIcon={<ArrowUp size={14} />}
            onSelect={() => onShare()}
            className="whitespace-nowrap"
          >
            {t("libraryAppCard.share")}
          </Menu.Item>
        ) : null}
        {onDeploy && isDeployed ? (
          <>
            <Menu.Item
              leftIcon={<Link2 size={14} />}
              shortcut={t("libraryAppCard.copyLink")}
              onSelect={() => onCopyDeployedLink?.()}
              className="whitespace-nowrap"
            >
              {t("libraryAppCard.deployed")}
            </Menu.Item>
            <Menu.Item
              leftIcon={<RefreshCw size={14} />}
              onSelect={() => onDeploy()}
              className="whitespace-nowrap"
            >
              {t("libraryAppCard.redeploy")}
            </Menu.Item>
          </>
        ) : onDeploy ? (
          <Menu.Item
            leftIcon={<Globe size={14} />}
            onSelect={() => onDeploy()}
            className="whitespace-nowrap"
          >
            {t("libraryAppCard.deploy")}
          </Menu.Item>
        ) : null}
        {onDelete ? (
          <Menu.Item
            leftIcon={<Trash2 size={14} className="text-red-600" />}
            onSelect={() => onDelete()}
            className="whitespace-nowrap text-red-600 data-[highlighted]:text-red-700"
          >
            {t("libraryAppCard.delete")}
          </Menu.Item>
        ) : null}
      </Menu.Content>
    </Menu.Root>
  );
}
