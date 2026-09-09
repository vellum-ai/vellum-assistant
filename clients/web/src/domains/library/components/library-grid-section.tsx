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
      <h2 className="mb-4 text-body-small-emphasised text-[color:var(--content-secondary)]">
        {title}
      </h2>
      {/* The colour the cards sit on: the page paints `--surface-base` and
          the grid nothing of its own. A card's title and date are transparent
          on it, and the swipe wrapper backs the card with this so a swiped
          card covers the action behind it instead of showing it through. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(max(220px,calc((100%-6rem)/5)),1fr))] gap-6 [--swipe-item-surface:var(--surface-base)]">
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
