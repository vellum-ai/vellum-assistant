/**
 * One app in the Chat Info panel's Apps row: a live preview of the app, an
 * options menu revealed over it, and the app's name underneath.
 */

import type { CSSProperties } from "react";
import { useCallback } from "react";

import { cn, Typography } from "@vellumai/design-library";

import { AppPreviewThumbnail } from "@/components/app-card";
import {
  AppAssetActions,
  AssetActionsSlot,
} from "@/domains/chat/components/conversation-asset-actions";
import { useTranslation } from "@/i18n";
import type { AppSummary } from "@/types/app-types";
import { getCachedAppHtml } from "@/utils/app-html-cache";

/** Fixed tile width, and the minimum the section fits a row of them to. */
export const CHAT_INFO_APP_TILE_WIDTH_PX = 184;

const FIXED_WIDTH_STYLE: CSSProperties = { width: CHAT_INFO_APP_TILE_WIDTH_PX };

interface ChatInfoAppTileProps {
  app: AppSummary;
  assistantId: string;
  onOpen: (appId: string) => void;
  /** Forwarded to `AppAssetActions`; the dialog is rendered by the panel. */
  onRequestDelete: (app: AppSummary) => void;
  /** In a fitted row the tile shares the row width with its siblings; in a strip or a wrapping grid it keeps its fixed width. */
  stretch?: boolean;
}

export function ChatInfoAppTile({
  app,
  assistantId,
  onOpen,
  onRequestDelete,
  stretch = false,
}: ChatInfoAppTileProps) {
  const { t } = useTranslation("chat");

  const loadHtml = useCallback(
    () => getCachedAppHtml(assistantId, app.id),
    [assistantId, app.id],
  );

  return (
    <div
      data-slot="chat-info-app-tile"
      data-reveal-row=""
      className={cn(
        "relative flex flex-col gap-1",
        stretch ? "min-w-0 flex-1" : "shrink-0",
      )}
      style={stretch ? undefined : FIXED_WIDTH_STYLE}
    >
      {/* The preview iframe is `pointer-events: none`, so this button takes the click. */}
      <button
        type="button"
        aria-label={t("chatInfoPanel.openAppAria", { name: app.name })}
        onClick={() => onOpen(app.id)}
        className="block w-full cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <AppPreviewThumbnail
          name={app.name}
          icon={app.icon}
          loadHtml={loadHtml}
        />
      </button>

      <AssetActionsSlot>
        <AppAssetActions
          assistantId={assistantId}
          app={app}
          onRequestDelete={onRequestDelete}
        />
      </AssetActionsSlot>

      <Typography
        variant="body-small-default"
        title={app.name}
        className="truncate text-[var(--content-tertiary)]"
      >
        {app.name}
      </Typography>
    </div>
  );
}
