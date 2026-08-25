import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, FileText, Layers } from "lucide-react";
import { useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import {
  BottomSheet,
  Button,
  PanelItem,
  Popover,
  Typography,
} from "@vellumai/design-library";

import {
  appsGetOptions,
  appsGetQueryKey,
  documentsGetOptions,
  documentsGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { DeleteAppDialog } from "@/components/delete-app-dialog";
import {
  AppAssetActions,
  DocumentAssetActions,
} from "@/domains/chat/components/conversation-asset-actions";
import {
  useHasUnseenDocumentChanges,
  useUnseenDocumentChangesStore,
} from "@/domains/chat/unseen-document-changes-store";
import { useAppDelete } from "@/hooks/use-app-delete";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTouchMobile } from "@/hooks/use-touch-mobile";
import { useTranslation } from "@/i18n";
import type { AppSummary } from "@/types/app-types";
import type { DocumentSummary } from "@/types/document-types";
import { cn } from "@/utils/misc";

export const ASSETS_PILL_UNSEEN_DOT_TESTID = "assets-pill-unseen-dot";

/** Bounded attention pulse defined in `src/index.css`. */
export const ASSETS_PILL_UNSEEN_DOT_PULSE_CLASS = "unseen-dot-pulse";

interface ConversationAsset {
  id: string;
  title: string;
  type: "app" | "document";
  appId?: string;
  surfaceId?: string;
  app?: AppSummary;
  doc?: DocumentSummary;
}

export interface ConversationAssetsPillProps {
  assistantId: string;
  conversationId: string;
  /** Bumped externally to trigger a refetch (e.g. on ui_surface_show). */
  refreshKey?: number;
  onOpenApp?: (appId: string) => void;
  onOpenDocument?: (surfaceId: string) => void;
}

function toAssets(
  apps: AppSummary[],
  docs: DocumentSummary[],
): ConversationAsset[] {
  const assets: ConversationAsset[] = [];
  for (const app of apps) {
    assets.push({
      id: `app-${app.id}`,
      title: app.name,
      type: "app",
      appId: app.id,
      app,
    });
  }
  for (const doc of docs) {
    assets.push({
      id: `doc-${doc.surfaceId}`,
      title: doc.title,
      type: "document",
      surfaceId: doc.surfaceId,
      doc,
    });
  }
  return assets;
}

export function ConversationAssetsPill({
  assistantId,
  conversationId,
  refreshKey,
  onOpenApp,
  onOpenDocument,
}: ConversationAssetsPillProps) {
  const queryClient = useQueryClient();
  const appsQueryOpts = appsGetOptions({
    path: { assistant_id: assistantId },
    query: { conversationId },
  });
  const docsQueryOpts = documentsGetOptions({
    path: { assistant_id: assistantId },
    query: { conversationId },
  });

  const { data: apps = [] } = useQuery({
    ...appsQueryOpts,
    select: (data) => data.apps,
  });
  const { data: docs = [] } = useQuery({
    ...docsQueryOpts,
    select: (data) => data.documents,
  });

  useEffect(() => {
    if (refreshKey === undefined) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: appsGetQueryKey({
        path: { assistant_id: assistantId },
        query: { conversationId },
      }),
    });
    void queryClient.invalidateQueries({
      queryKey: documentsGetQueryKey({
        path: { assistant_id: assistantId },
        query: { conversationId },
      }),
    });
  }, [refreshKey, queryClient, assistantId, conversationId]);

  const assets = useMemo(() => toAssets(apps, docs), [apps, docs]);

  const [open, setOpen] = useState(false);

  // The chat header swaps `conversationId` on this same mounted pill, so an
  // open disclosure would otherwise carry over and list the incoming
  // conversation's assets without the user asking to see them, leaving that
  // conversation's changes marked unseen behind a sheet that is already open.
  // Layout effect: the outgoing conversation's disclosure must never paint
  // over the incoming conversation, not even for one frame.
  useLayoutEffect(() => {
    setOpen(false);
  }, [conversationId]);

  // Two independent questions: the header cluster only has room for a labelled
  // pill on a roomy window, and the disclosure is a sheet only under a thumb.
  const isMobile = useIsMobile();
  const isTouchMobile = useTouchMobile();
  const { t } = useTranslation("chat");
  const reduceMotion = useReducedMotion();
  const hasUnseenChanges = useHasUnseenDocumentChanges(conversationId);
  const clearConversation =
    useUnseenDocumentChangesStore.use.clearConversation();

  // Opening the disclosure is the user looking at the asset list, so whatever
  // changed is no longer unseen.
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) {
        clearConversation(conversationId);
      }
    },
    [clearConversation, conversationId],
  );

  const handleSelect = useCallback(
    (asset: ConversationAsset) => {
      setOpen(false);
      if (asset.type === "app" && asset.appId) {
        onOpenApp?.(asset.appId);
      } else if (asset.type === "document" && asset.surfaceId) {
        onOpenDocument?.(asset.surfaceId);
      }
    },
    [onOpenApp, onOpenDocument],
  );

  const appDelete = useAppDelete(assistantId);

  if (assets.length === 0) {
    return null;
  }

  // ICU `plural` picks the category through `Intl.PluralRules` for the active
  // locale, so both strings agree with `count` in languages with more than the
  // two forms English has. The unseen variant is its own key rather than a
  // `select` branch appended to the base one: translators get a whole sentence
  // to work with, and languages that place the qualifier somewhere other than
  // the end are free to move it.
  const label = t("conversationAssets.label", { count: assets.length });
  const ariaLabel = hasUnseenChanges
    ? t("conversationAssets.ariaLabelUnseen", { count: assets.length })
    : t("conversationAssets.ariaLabel", { count: assets.length });

  // Same dot as the notifications bell in this header cluster: ringed in the
  // color of the surface behind it so the ring reads as a gap carved out of
  // the icon. The dot mounts only while changes are unseen, so the CSS pulse
  // runs on appearance and needs no restart bookkeeping.
  //
  // This wrapper is the dot's positioning context and the element the Button
  // sizes in place of the glyph. `iconOnly` sizes the glyph with its own
  // `[&_svg]` rule, which reaches through the wrapper, so a size rule here
  // would only compete with it. `leftIcon` sizes just the box it provides, so
  // there the wrapper fills that box and hands the size down to the glyph.
  const layersIcon = (
    <span
      className={cn(
        "relative flex",
        !isMobile && "size-full [&_svg]:size-full",
      )}
      aria-hidden
    >
      <Layers />
      {hasUnseenChanges ? (
        <span
          data-testid={ASSETS_PILL_UNSEEN_DOT_TESTID}
          className={cn(
            "absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-[var(--surface-base)] bg-[var(--system-mid-strong)] touch-mobile:border-[var(--surface-lift)]",
            !reduceMotion && ASSETS_PILL_UNSEEN_DOT_PULSE_CLASS,
          )}
        />
      ) : null}
    </span>
  );

  const assetItems = assets.map((asset) => (
    <PanelItem
      key={asset.id}
      icon={asset.type === "app" ? AppWindow : FileText}
      label={asset.title}
      onSelect={() => handleSelect(asset)}
      trailingAction={
        asset.type === "app" && asset.app ? (
          <AppAssetActions
            assistantId={assistantId}
            app={asset.app}
            onRequestDelete={appDelete.requestDelete}
          />
        ) : asset.type === "document" && asset.doc ? (
          <DocumentAssetActions
            assistantId={assistantId}
            doc={asset.doc}
            onOpen={() => handleSelect(asset)}
          />
        ) : undefined
      }
    />
  ));

  const trigger = isMobile ? (
    <Button
      variant="ghost"
      active
      iconOnly={layersIcon}
      tintColor="var(--content-default)"
      aria-label={ariaLabel}
    />
  ) : (
    <Button
      variant="ghost"
      active
      leftIcon={layersIcon}
      className="rounded-full"
      tintColor="var(--content-default)"
      aria-label={ariaLabel}
    >
      {label}
    </Button>
  );

  if (isTouchMobile) {
    return (
      <>
        <BottomSheet.Root open={open} onOpenChange={handleOpenChange}>
          <BottomSheet.Trigger asChild>{trigger}</BottomSheet.Trigger>
          <BottomSheet.Content>
            <BottomSheet.Header>
              <BottomSheet.Title>{t("conversationAssets.heading")}</BottomSheet.Title>
            </BottomSheet.Header>
            <BottomSheet.Body className="pt-0">{assetItems}</BottomSheet.Body>
          </BottomSheet.Content>
        </BottomSheet.Root>
        <DeleteAppDialog
          app={appDelete.pendingDelete}
          isDeleting={appDelete.isDeleting}
          onConfirm={appDelete.confirmDelete}
          onCancel={appDelete.cancelDelete}
        />
      </>
    );
  }

  return (
    <>
      <Popover.Root open={open} onOpenChange={handleOpenChange}>
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
        {/*
          The popover keeps its own `p-2` inset and the heading sits at
          `px-2`, which is the column the rows' icons start from. Its own
          vertical padding is only what separates it from the first row: the
          label is 10px on a `line-height: 1`, and the popover's inset above
          and the row's 8px of padding below already carry the rest.
        */}
        <Popover.Content
          side="bottom"
          align="center"
          sideOffset={8}
          className="w-60"
        >
          <div className="px-2 pb-1">
            <Typography
              variant="label-small-default"
              className="text-[var(--content-tertiary)]"
            >
              {t("conversationAssets.heading")}
            </Typography>
          </div>
          <div className="max-h-[240px] overflow-y-auto">{assetItems}</div>
        </Popover.Content>
      </Popover.Root>
      <DeleteAppDialog
        app={appDelete.pendingDelete}
        isDeleting={appDelete.isDeleting}
        onConfirm={appDelete.confirmDelete}
        onCancel={appDelete.cancelDelete}
      />
    </>
  );
}
