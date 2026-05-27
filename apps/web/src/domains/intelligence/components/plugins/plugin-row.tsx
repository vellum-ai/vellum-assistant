import type { KeyboardEvent } from "react";

import { Card } from "@vellum/design-library";
import type { PluginInfo } from "@/domains/intelligence/plugins/types";

interface PluginRowProps {
  plugin: PluginInfo;
  /**
   * Optional row-level click handler. The Plugins tab doesn't yet have
   * a detail view; passing `onSelect` keeps the affordance ready for
   * when one lands without changing the row contract.
   */
  onSelect?: () => void;
}

export function PluginRow({ plugin, onSelect }: PluginRowProps) {
  const interactive = Boolean(onSelect);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!onSelect) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <Card.Root asChild>
      <div
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        onClick={onSelect}
        onKeyDown={handleKeyDown}
        className={
          "flex items-center gap-4 px-5 py-4 text-left transition-colors" +
          (interactive
            ? " cursor-pointer hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            : "")
        }
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
              style={{ color: "var(--content-warning, var(--content-tertiary))" }}
              title={plugin.issues.join("; ")}
            >
              {plugin.issues[0]}
              {plugin.issues.length > 1
                ? ` (+${plugin.issues.length - 1} more)`
                : ""}
            </p>
          ) : null}
        </div>
      </div>
    </Card.Root>
  );
}
