import { Card } from "@vellum/design-library";
import type { PluginCatalogMatch } from "@/domains/intelligence/plugins/types";

interface CatalogRowProps {
  match: PluginCatalogMatch;
}

/**
 * Row for a single catalog entry. Mirrors {@link PluginRow}'s visual
 * shape but surfaces the install-via-CLI hint instead of an installed
 * plugin's metadata. Non-interactive — install is CLI-only while the
 * on-disk plugin layout firms up.
 */
export function CatalogRow({ match }: CatalogRowProps) {
  const installHint = `assistant plugins install ${match.name}`;

  return (
    <Card.Root asChild>
      <div className="flex items-center gap-4 px-5 py-4 text-left">
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
          <p
            className="mt-1 truncate text-body-small-default"
            style={{ color: "var(--content-tertiary)" }}
            title={match.path}
          >
            {match.path}
          </p>
          <p
            className="mt-1 truncate text-body-medium-lighter"
            style={{ color: "var(--content-secondary)" }}
          >
            Install via CLI:{" "}
            <code
              className="rounded px-1 py-0.5 text-body-small-default"
              style={{
                backgroundColor: "var(--surface-secondary)",
                color: "var(--content-default)",
              }}
            >
              {installHint}
            </code>
          </p>
        </div>
      </div>
    </Card.Root>
  );
}
