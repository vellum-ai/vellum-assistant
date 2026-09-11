/**
 * Renders a labeled section of the library grid (Pinned, Recents, etc.)
 * with a responsive auto-fill grid layout.
 */

import type { AppSummary } from "@/types/app-types";
import { LibraryAppCard } from "@/domains/library/components/library-app-card";

interface LibraryGridSectionProps {
  title: string;
  apps: AppSummary[];
  assistantId: string;
  pinnedAppIds: Set<string>;
  lastImportedAppId?: string | null;
  onOpen: (appId: string) => void;
  onPin: (app: AppSummary) => void;
  onDelete: (app: AppSummary) => void;
  onDeploy?: (appId: string) => void;
  onAnimationEnd?: () => void;
}

export function LibraryGridSection({
  title,
  apps,
  assistantId,
  pinnedAppIds,
  lastImportedAppId,
  onOpen,
  onPin,
  onDelete,
  onDeploy,
  onAnimationEnd,
}: LibraryGridSectionProps) {
  if (apps.length === 0) {
    return null;
  }

  return (
    <section>
      <h2 className="mb-4 text-body-small-emphasised text-[color:var(--content-secondary)] max-md:sr-only">
        {title}
      </h2>
      {/* On mobile each app name sits directly on the page surface. The swipe
          item uses that same opaque surface so its actions stay covered at
          rest, while desktop keeps its established card surface. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(max(220px,calc((100%-6rem)/5)),1fr))] gap-6 [--swipe-item-surface:var(--surface-base)] max-md:[--swipe-item-surface:var(--surface-overlay)]">
        {apps.map((app) => (
          <LibraryAppCard
            key={app.id}
            app={app}
            assistantId={assistantId}
            isPinned={pinnedAppIds.has(app.id)}
            onOpen={onOpen}
            onPin={onPin}
            onDelete={onDelete}
            justImported={app.id === lastImportedAppId}
            onAnimationEnd={onAnimationEnd}
            onDeploy={onDeploy ? () => onDeploy(app.id) : undefined}
          />
        ))}
      </div>
    </section>
  );
}
