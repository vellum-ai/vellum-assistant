import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, FileText, Layers } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

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
import { useIsMobile } from "@/hooks/use-is-mobile";
import type { AppSummary } from "@/types/app-types";
import type { DocumentSummary } from "@/types/document-types";

interface ConversationAsset {
  id: string;
  title: string;
  type: "app" | "document";
  appId?: string;
  surfaceId?: string;
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
    });
  }
  for (const doc of docs) {
    assets.push({
      id: `doc-${doc.surfaceId}`,
      title: doc.title,
      type: "document",
      surfaceId: doc.surfaceId,
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
    if (refreshKey === undefined) return;
    void queryClient.invalidateQueries({
      queryKey: appsGetQueryKey({ path: { assistant_id: assistantId }, query: { conversationId } }),
    });
    void queryClient.invalidateQueries({
      queryKey: documentsGetQueryKey({ path: { assistant_id: assistantId }, query: { conversationId } }),
    });
  }, [refreshKey, queryClient, assistantId, conversationId]);

  const assets = useMemo(() => toAssets(apps, docs), [apps, docs]);

  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();

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

  if (assets.length === 0) {
    return null;
  }

  const label = assets.length === 1 ? "1 asset" : `${assets.length} assets`;
  const ariaLabel = `Conversation assets, ${assets.length} items`;

  const assetItems = assets.map((asset) => (
    <PanelItem
      key={asset.id}
      icon={asset.type === "app" ? AppWindow : FileText}
      label={asset.title}
      onSelect={() => handleSelect(asset)}
    />
  ));

  if (isMobile) {
    return (
      <BottomSheet.Root open={open} onOpenChange={setOpen}>
        <BottomSheet.Trigger asChild>
          <Button
            variant="ghost"
            active
            iconOnly={<Layers />}
            tintColor="var(--content-default)"
            aria-label={ariaLabel}
          />
        </BottomSheet.Trigger>
        <BottomSheet.Content>
          <BottomSheet.Header>
            <BottomSheet.Title>Assets</BottomSheet.Title>
          </BottomSheet.Header>
          <BottomSheet.Body className="pt-0">{assetItems}</BottomSheet.Body>
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          active
          leftIcon={<Layers />}
          className="rounded-full"
          tintColor="var(--content-default)"
          aria-label={ariaLabel}
        >
          {label}
        </Button>
      </Popover.Trigger>
      <Popover.Content
        side="bottom"
        align="center"
        sideOffset={8}
        className="w-60 p-0"
      >
        <div className="px-3 pt-3 pb-1">
          <Typography
            variant="label-small-default"
            className="text-[var(--content-tertiary)]"
          >
            Assets
          </Typography>
        </div>
        <div className="max-h-[240px] overflow-y-auto px-2 pb-2">
          {assetItems}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
