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
import type { FC, KeyboardEvent, MouseEvent, ReactNode } from "react";

import { ActionMenu, Button, toast } from "@vellumai/design-library";

import { downloadDocumentPdf } from "@/domains/chat/api/surfaces";
import { t } from "@/i18n";
import { usePinnedApps } from "@/hooks/use-pinned-apps";
import type { AppSummary } from "@/types/app-types";
import type { DocumentSummary } from "@/types/document-types";
import { shareApp } from "@/utils/share-app";

/**
 * Per-row options menu ("dots") for the conversation assets pill: a trailing
 * `Ellipsis` button opening an `ActionMenu`, which resolves to a sheet on touch
 * and a dropdown under a pointer (see `docs/PLATFORM_ADAPTATION.md`).
 *
 * Apps get the gallery's actions (Pin / Share / Delete). Documents get
 * Open / Download PDF — the daemon has no document-delete endpoint, so
 * deletion is intentionally absent there.
 */

function MenuShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <ActionMenu.Root>
      <ActionMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="compact"
          expandOnMobile={false}
          iconOnly={<Ellipsis />}
          aria-label={title}
          onClick={(e: MouseEvent) => e.stopPropagation()}
          // PanelItem's row handler also acts on Enter/Space, so they stay
          // local: opening the menu must not open the asset.
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
            }
          }}
        />
      </ActionMenu.Trigger>
      <ActionMenu.Content title={title}>{children}</ActionMenu.Content>
    </ActionMenu.Root>
  );
}

// ---------------------------------------------------------------------------
// App actions
// ---------------------------------------------------------------------------

interface AppAssetActionsProps {
  assistantId: string;
  app: AppSummary;
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
  onRequestDelete,
}) => {
  const { togglePin, pinnedAppIds } = usePinnedApps(assistantId);
  const isPinned = pinnedAppIds.has(app.id);

  const [isSharing, setIsSharing] = useState(false);
  const handleShare = useCallback(async () => {
    if (isSharing) {
      return;
    }
    setIsSharing(true);
    try {
      await shareApp(assistantId, app.id, app.name);
      toast.success(t("chat:appAssetActions.appExported"), {
        description: `${app.name}.vellum`,
      });
    } catch (err) {
      toast.error(t("chat:appAssetActions.shareFailed"), {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setIsSharing(false);
    }
  }, [assistantId, app.id, app.name, isSharing]);

  return (
    <MenuShell title={t("chat:conversationAssetActions.optionsFor", { name: app.name })}>
      <ActionMenu.Item
        icon={isPinned ? PinOff : Pin}
        label={isPinned ? t("chat:conversationAssetActions.unpin") : t("chat:conversationAssetActions.pin")}
        onSelect={() => togglePin(app.id)}
      />
      <ActionMenu.Item
        icon={ArrowUp}
        label={t("chat:conversationAssetActions.share")}
        description={t("chat:conversationAssetActions.exportAsVellum")}
        onSelect={() => void handleShare()}
      />
      <ActionMenu.Item
        icon={Trash2}
        label={t("chat:conversationAssetActions.delete")}
        tone="destructive"
        onSelect={() => onRequestDelete(app)}
      />
    </MenuShell>
  );
};

// ---------------------------------------------------------------------------
// Document actions
// ---------------------------------------------------------------------------

interface DocumentAssetActionsProps {
  assistantId: string;
  doc: DocumentSummary;
  onOpen: () => void;
}

export const DocumentAssetActions: FC<DocumentAssetActionsProps> = ({
  assistantId,
  doc,
  onOpen,
}) => {
  const handleDownloadPdf = useCallback(async () => {
    try {
      await downloadDocumentPdf(assistantId, doc.surfaceId, doc.title);
    } catch {
      toast.error(t("chat:documentAssetActions.pdfDownloadFailed"));
    }
  }, [assistantId, doc.surfaceId, doc.title]);

  return (
    <MenuShell title={t("chat:conversationAssetActions.optionsFor", { name: doc.title })}>
      <ActionMenu.Item icon={ExternalLink} label={t("chat:conversationAssetActions.open")} onSelect={onOpen} />
      <ActionMenu.Item
        icon={Download}
        label={t("chat:conversationAssetActions.downloadPdf")}
        onSelect={() => void handleDownloadPdf()}
      />
    </MenuShell>
  );
};
