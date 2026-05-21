/* eslint-disable no-restricted-syntax -- LUM-1768: file contains dark: pairs pending semantic-token migration */

import { ExternalLink } from "lucide-react";

import type { Surface } from "@/domains/chat/types/types.js";

import { SurfaceContainer } from "@/domains/chat/components/surfaces/surface-container.js";

interface BrowserViewSurfaceData {
  url: string;
  title?: string;
}

interface BrowserViewSurfaceProps {
  surface: Surface;
  onAction: (surfaceId: string, actionId: string, data?: Record<string, unknown>) => void;
}

export function BrowserViewSurface({ surface, onAction }: BrowserViewSurfaceProps) {
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
            <a
              href={data.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1.5 text-body-medium-lighter text-forest-600 underline decoration-forest-600/30 transition-colors hover:text-forest-700 hover:decoration-forest-700/50 dark:text-forest-400 dark:decoration-forest-400/30 dark:hover:text-forest-300"
            >
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              <span className="break-all">{data.url}</span>
            </a>
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
