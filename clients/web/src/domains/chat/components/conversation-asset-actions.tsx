import {
  ArrowUp,
  Download,
  Ellipsis,
  ExternalLink,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { useCallback } from "react";
import type { FC, ReactNode } from "react";

import { ActionMenu, Button, toast } from "@vellumai/design-library";

import { downloadDocumentPdf } from "@/domains/chat/api/surfaces";
import { t } from "@/i18n";
import { usePinnedApps } from "@/hooks/use-pinned-apps";
import { useShareApp } from "@/hooks/use-share-app";
import type { AppSummary } from "@/types/app-types";
import type { DocumentSummary } from "@/types/document-types";

/**
 * The options menu ("dots") the Chat Info panel's app and file tiles reveal
 * over their preview: an `Ellipsis` button opening an `ActionMenu`, which
 * resolves to a sheet on touch and a dropdown under a pointer (see
 * `docs/PLATFORM_ADAPTATION.md`).
 *
 * Apps get the gallery's actions (Pin / Share / Delete). Documents get
 * Open / Download PDF: the daemon has no document-delete endpoint, so
 * deletion is intentionally absent there.
 */

/**
 * Plate the revealed options menu sits on, pinned to the tile's top-right
 * corner. Both tiles share it so the menu keeps reading against whatever the
 * preview underneath happens to be.
 */
export function AssetActionsSlot({ children }: { children: ReactNode }) {
  return (
    <span
      data-reveal=""
      className="absolute right-1 top-1 rounded-md bg-[var(--surface-lift)]"
    >
      {children}
    </span>
  );
}

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
   * Ask the owner to show the delete confirmation. The panel owns the dialog
   * so it survives this tile remounting or the panel switching level; the menu
   * only asks for it.
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

  const share = useShareApp(assistantId, app, {
    exported: t("chat:appAssetActions.appExported"),
    failed: t("chat:appAssetActions.shareFailed"),
  });

  return (
    <MenuShell
      title={t("chat:conversationAssetActions.optionsFor", { name: app.name })}
    >
      <ActionMenu.Item
        icon={isPinned ? PinOff : Pin}
        label={
          isPinned
            ? t("chat:conversationAssetActions.unpin")
            : t("chat:conversationAssetActions.pin")
        }
        onSelect={() => togglePin(app.id)}
      />
      <ActionMenu.Item
        icon={ArrowUp}
        label={t("chat:conversationAssetActions.share")}
        description={t("chat:conversationAssetActions.exportAsVellum")}
        onSelect={() => void share()}
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
    <MenuShell
      title={t("chat:conversationAssetActions.optionsFor", { name: doc.title })}
    >
      <ActionMenu.Item
        icon={ExternalLink}
        label={t("chat:conversationAssetActions.open")}
        onSelect={onOpen}
      />
      <ActionMenu.Item
        icon={Download}
        label={t("chat:conversationAssetActions.downloadPdf")}
        onSelect={() => void handleDownloadPdf()}
      />
    </MenuShell>
  );
};
