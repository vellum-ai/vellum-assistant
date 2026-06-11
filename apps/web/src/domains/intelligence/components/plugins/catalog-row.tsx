import { ChevronRight } from "lucide-react";
import { Link } from "react-router";

import type { PluginsSearchGetResponse } from "@/generated/daemon/types.gen";
import { routes } from "@/utils/routes";
import { Card } from "@vellumai/design-library";

interface CatalogRowProps {
  match: PluginsSearchGetResponse["matches"][number];
}

/**
 * Row for a single catalog entry. Links to the plugin's detail page,
 * where the README, tracked metadata, and an Install action live. The
 * hover affordance (surface tint + chevron) signals the row is
 * navigable.
 */
export function CatalogRow({ match }: CatalogRowProps) {
  return (
    <Card.Root asChild>
      <Link
        to={routes.plugin(match.name)}
        className="group flex cursor-pointer items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center text-2xl">
          📦
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="truncate text-body-medium-default"
              style={{ color: "var(--content-default)" }}
            >
              {match.name}
            </span>
          </div>
          {match.description && (
            <p
              className="mt-1 truncate text-body-small-default"
              style={{ color: "var(--content-secondary)" }}
            >
              {match.description}
            </p>
          )}
          <p
            className="mt-1 truncate text-body-small-default"
            style={{ color: "var(--content-tertiary)" }}
            title={match.path}
          >
            {match.path}
          </p>
        </div>
        <ChevronRight
          className="h-5 w-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          style={{ color: "var(--content-tertiary)" }}
          aria-hidden
        />
      </Link>
    </Card.Root>
  );
}
