import { AppWindow, FileText, Layers } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  BottomSheet,
  Button,
  PanelItem,
  Popover,
  Typography,
} from "@vellum/design-library";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { listApps, type AppSummary } from "@/domains/chat/api/apps";
import {
  listDocuments,
  type DocumentSummary,
} from "@/domains/chat/api/documents";

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

interface AssetsState {
  conversationId: string;
  assets: ConversationAsset[];
}

export function ConversationAssetsPill({
  assistantId,
  conversationId,
  refreshKey,
  onOpenApp,
  onOpenDocument,
}: ConversationAssetsPillProps) {
  const [state, setState] = useState<AssetsState>({
    conversationId,
    assets: [],
  });
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();

  const assets =
    state.conversationId === conversationId ? state.assets : [];

  useEffect(() => {
    let cancelled = false;

    async function fetchAssets() {
      try {
        const [apps, docs] = await Promise.all([
          listApps(assistantId, conversationId),
          listDocuments(assistantId, conversationId),
        ]);
        if (!cancelled) {
          setState({ conversationId, assets: toAssets(apps, docs) });
        }
      } catch {
        // Best-effort — don't break the UI if the endpoints aren't available
      }
    }

    fetchAssets();
    return () => {
      cancelled = true;
    };
  }, [assistantId, conversationId, refreshKey]);

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
