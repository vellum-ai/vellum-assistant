import { ChevronRight } from "lucide-react";
import { Link } from "react-router";

import type { PluginsGetResponse } from "@/generated/daemon/types.gen";
import { routes } from "@/utils/routes";
import { Card } from "@vellumai/design-library";

interface PluginRowProps {
  plugin: PluginsGetResponse["plugins"][number];
}

/**
 * Row for a single installed plugin. Links to the plugin's detail page,
 * where the README, tracked metadata, and a Remove action live. The
 * hover affordance (surface tint + chevron) signals the row is
 * navigable.
 */
export function PluginRow({ plugin }: PluginRowProps) {
  return (
    <Card.Root asChild>
      <Link
        to={routes.plugin(plugin.name)}
        className="group flex cursor-pointer items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center text-2xl">
          🧩
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="truncate text-body-medium-default"
              style={{ color: "var(--content-default)" }}
            >
              {plugin.name}
            </span>
            {plugin.version ? (
              <span
                className="shrink-0 text-body-small-default"
                style={{ color: "var(--content-tertiary)" }}
              >
                v{plugin.version}
              </span>
            ) : null}
          </div>
          <p
            className="mt-1 truncate text-body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            {plugin.description ?? "No description provided."}
          </p>
          {plugin.issues && plugin.issues.length > 0 ? (
            <p
              className="mt-1 truncate text-body-small-default"
              style={{
                color: "var(--content-warning, var(--content-tertiary))",
              }}
              title={plugin.issues.join("; ")}
            >
              {plugin.issues[0]}
              {plugin.issues.length > 1
                ? ` (+${plugin.issues.length - 1} more)`
                : ""}
            </p>
          ) : null}
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
