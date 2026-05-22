import { ArrowDownToLine, Loader2, Trash2 } from "lucide-react";
import type { KeyboardEvent } from "react";

import { Button, Card } from "@vellum/design-library";
import {
  isAvailablePlugin,
  isInstalledPlugin,
  type PluginInfo,
} from "@/domains/intelligence/plugins/types.js";

interface PluginRowProps {
  plugin: PluginInfo;
  onSelect: () => void;
  onInstall?: () => void;
  onRemove?: () => void;
  isInstalling?: boolean;
  isRemoving?: boolean;
}

export function PluginRow({
  plugin,
  onSelect,
  onInstall,
  onRemove,
  isInstalling = false,
  isRemoving = false,
}: PluginRowProps) {
  const available = isAvailablePlugin(plugin);
  const installed = isInstalledPlugin(plugin);

  const handleRowKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <Card.Root asChild>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={handleRowKeyDown}
        className="flex cursor-pointer items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
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

        {available ? (
          isInstalling ? (
            <div className="flex h-9 items-center px-3" aria-label="Installing">
              <Loader2
                className="h-4 w-4 animate-spin"
                style={{ color: "var(--content-tertiary)" }}
              />
            </div>
          ) : (
            <Button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onInstall?.();
              }}
              disabled={!onInstall}
              leftIcon={<ArrowDownToLine aria-hidden />}
            >
              Install
            </Button>
          )
        ) : (
          <Button
            type="button"
            variant="dangerOutline"
            onClick={(e) => {
              e.stopPropagation();
              onRemove?.();
            }}
            disabled={!installed || isRemoving || !onRemove}
            aria-label="Remove plugin"
            leftIcon={
              isRemoving ? (
                <Loader2 className="animate-spin" aria-hidden />
              ) : (
                <Trash2 aria-hidden />
              )
            }
          >
            Remove
          </Button>
        )}
      </div>
    </Card.Root>
  );
}
