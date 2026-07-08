import { useQueryClient } from "@tanstack/react-query";
import {
    ArrowUp,
    Download,
    Ellipsis,
    ExternalLink,
    Pin,
    PinOff,
    Trash2,
} from "lucide-react";
import { useCallback, useState } from "react";
import type { FC, MouseEvent, ReactNode } from "react";

import { BottomSheet, Button, Menu, PanelItem, toast } from "@vellumai/design-library";

import { appsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { appsByIdDeletePost, documentsByIdPdfGet } from "@/generated/daemon/sdk.gen";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import type { AppSummary } from "@/types/app-types";
import type { DocumentSummary } from "@/types/document-types";
import { clearAppHtmlCache } from "@/utils/app-html-cache";
import { shareApp } from "@/utils/share-app";

/**
 * Per-row options menu ("dots") for the conversation assets pill, mirroring
 * the gallery's `LibraryAppCardActionsMenu` pattern: a trailing `Ellipsis`
 * button that opens a nested `BottomSheet` on mobile and a `Menu` on desktop.
 *
 * Apps get the gallery's actions (Pin / Share / Delete). Documents get
 * Open / Download PDF — the daemon has no document-delete endpoint, so
 * deletion is intentionally absent there.
 */

interface MenuShellProps {
  isMobile: boolean;
  title: string;
  ariaLabel: string;
  children: (close: () => void) => ReactNode;
  desktopItems: ReactNode;
}

function MenuShell({ isMobile, title, ariaLabel, children, desktopItems }: MenuShellProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  const trigger = (
    <Button
      variant="ghost"
      size="compact"
      expandOnMobile={false}
      iconOnly={<Ellipsis />}
      aria-label={ariaLabel}
      onClick={(e: MouseEvent) => e.stopPropagation()}
    />
  );

  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={setOpen}>
        <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
        <BottomSheet.Content>
          <BottomSheet.Header className="sr-only">
            <BottomSheet.Title>{title}</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">{children(close)}</BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }
  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger asChild>{trigger}</Menu.Trigger>
      <Menu.Content align="end" sideOffset={4}>
        {desktopItems}
      </Menu.Content>
    </Menu.Root>
  );
}

// ---------------------------------------------------------------------------
// Delete state (owned by the pill, outside the popover/sheet)
// ---------------------------------------------------------------------------

/**
 * App-deletion state and mutation for the assets pill. Lives OUTSIDE the
 * Popover/BottomSheet subtree (see `onRequestDelete` note above), mirroring
 * the gallery's delete flow: `appsByIdDeletePost` + HTML cache clear +
 * `appsGet` invalidation + unpin.
 */
export function useAppDelete(assistantId: string) {
  const queryClient = useQueryClient();
  const togglePin = usePinnedAppsStore.use.togglePin();
  const pinnedAppIds = usePinnedAppsStore.use.pinnedAppIds();
  const [pendingDelete, setPendingDelete] = useState<AppSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete || isDeleting) {
      return;
    }
    setIsDeleting(true);
    try {
      await appsByIdDeletePost({
        path: { assistant_id: assistantId, id: pendingDelete.id },
        throwOnError: true,
      });
      clearAppHtmlCache(assistantId, pendingDelete.id);
      void queryClient.invalidateQueries({
        queryKey: appsGetQueryKey({ path: { assistant_id: assistantId } }),
      });
      if (pinnedAppIds.has(pendingDelete.id)) {
        togglePin(pendingDelete);
      }
      setPendingDelete(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete app");
    } finally {
      setIsDeleting(false);
    }
  }, [pendingDelete, isDeleting, assistantId, pinnedAppIds, togglePin, queryClient]);

  const cancelDelete = useCallback(() => {
    if (!isDeleting) {
      setPendingDelete(null);
    }
  }, [isDeleting]);

  return { pendingDelete, isDeleting, requestDelete: setPendingDelete, confirmDelete, cancelDelete };
}

// ---------------------------------------------------------------------------
// App actions
// ---------------------------------------------------------------------------

interface AppAssetActionsProps {
  assistantId: string;
  app: AppSummary;
  isMobile: boolean;
  /**
   * Ask the owner to show the delete confirmation. The dialog must be
   * rendered OUTSIDE the hosting Popover/BottomSheet: it portals and steals
   * focus, which the popover treats as an outside interaction and closes —
   * unmounting this component and any dialog state held here with it.
   */
  onRequestDelete: (app: AppSummary) => void;
}

export const AppAssetActions: FC<AppAssetActionsProps> = ({
  assistantId,
  app,
  isMobile,
  onRequestDelete,
}) => {
  const togglePin = usePinnedAppsStore.use.togglePin();
  const pinnedAppIds = usePinnedAppsStore.use.pinnedAppIds();
  const isPinned = pinnedAppIds.has(app.id);

  const [isSharing, setIsSharing] = useState(false);
  const handleShare = useCallback(async () => {
    if (isSharing) {
      return;
    }
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

  return (
    <MenuShell
        isMobile={isMobile}
        title={app.name}
        ariaLabel={`Options for ${app.name}`}
        desktopItems={
          <>
            <Menu.Item
              leftIcon={isPinned ? <PinOff size={14} /> : <Pin size={14} />}
              onSelect={() => togglePin(app)}
              className="whitespace-nowrap"
            >
              {isPinned ? "Unpin" : "Pin"}
            </Menu.Item>
            <Menu.Item
              leftIcon={<ArrowUp size={14} />}
              onSelect={() => void handleShare()}
              className="whitespace-nowrap"
            >
              Share
            </Menu.Item>
            <Menu.Item
              leftIcon={<Trash2 size={14} />}
              onSelect={() => onRequestDelete(app)}
              className="whitespace-nowrap"
            >
              Delete
            </Menu.Item>
          </>
        }
      >
        {(close) => (
          <>
            <PanelItem
              icon={isPinned ? PinOff : Pin}
              label={isPinned ? "Unpin" : "Pin"}
              onSelect={() => {
                close();
                togglePin(app);
              }}
            />
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
                close();
                void handleShare();
              }}
            />
            <PanelItem
              icon={Trash2}
              label="Delete"
              onSelect={() => {
                close();
                onRequestDelete(app);
              }}
            />
          </>
        )}
    </MenuShell>
  );
};

// ---------------------------------------------------------------------------
// Document actions
// ---------------------------------------------------------------------------

interface DocumentAssetActionsProps {
  assistantId: string;
  doc: DocumentSummary;
  isMobile: boolean;
  onOpen: () => void;
}

export const DocumentAssetActions: FC<DocumentAssetActionsProps> = ({
  assistantId,
  doc,
  isMobile,
  onOpen,
}) => {
  const handleDownloadPdf = useCallback(async () => {
    const { data: blob, response } = await documentsByIdPdfGet({
      path: { assistant_id: assistantId, id: doc.surfaceId },
      throwOnError: false,
      parseAs: "blob",
    });
    if (!response?.ok || !blob) {
      toast.error("Failed to download PDF");
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `${doc.title || "document"}.pdf`,
    });
    a.click();
    URL.revokeObjectURL(url);
  }, [assistantId, doc.surfaceId, doc.title]);

  return (
    <MenuShell
      isMobile={isMobile}
      title={doc.title}
      ariaLabel={`Options for ${doc.title}`}
      desktopItems={
        <>
          <Menu.Item
            leftIcon={<ExternalLink size={14} />}
            onSelect={onOpen}
            className="whitespace-nowrap"
          >
            Open
          </Menu.Item>
          <Menu.Item
            leftIcon={<Download size={14} />}
            onSelect={() => void handleDownloadPdf()}
            className="whitespace-nowrap"
          >
            Download PDF
          </Menu.Item>
        </>
      }
    >
      {(close) => (
        <>
          <PanelItem
            icon={ExternalLink}
            label="Open"
            onSelect={() => {
              close();
              onOpen();
            }}
          />
          <PanelItem
            icon={Download}
            label="Download PDF"
            onSelect={() => {
              close();
              void handleDownloadPdf();
            }}
          />
        </>
      )}
    </MenuShell>
  );
};
