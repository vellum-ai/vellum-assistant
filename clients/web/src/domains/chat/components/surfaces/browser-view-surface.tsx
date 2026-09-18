import { ExternalLink } from "lucide-react";

import { ExternalAnchor } from "@/components/external-anchor";
import type { Surface } from "@/domains/chat/types/types";

import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container";

interface BrowserViewSurfaceData {
  url: string;
  title?: string;
}

interface BrowserViewSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
}

export function BrowserViewSurface({
  surface,
  onAction,
}: BrowserViewSurfaceProps) {
  const data = surface.data as unknown as BrowserViewSurfaceData;

  return (
    <SurfaceContainer surface={surface} onAction={onAction}>
      <div>
        {data.title && (
          <h3 className="text-title-small text-[var(--content-strong)]">
            {data.title}
          </h3>
        )}

        {(() => {
          const isSafeUrl = /^https?:\/\//i.test(data.url ?? "");
          return isSafeUrl ? (
            <ExternalAnchor
              href={data.url}
              className="mt-1 inline-flex items-center gap-1.5 text-body-medium-lighter text-[var(--system-positive-strong)] underline decoration-[var(--system-positive-strong)]/30 transition-colors hover:opacity-80"
              glyph={false}
            >
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              <span className="break-all">{data.url}</span>
            </ExternalAnchor>
          ) : (
            <span className="mt-1 text-body-medium-lighter text-[var(--content-quiet)] break-all">
              {data.url}
            </span>
          );
        })()}
      </div>
    </SurfaceContainer>
  );
}
