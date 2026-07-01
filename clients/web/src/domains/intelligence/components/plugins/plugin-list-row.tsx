import { ArrowDownToLine, Loader2, Trash2 } from "lucide-react";
import type { KeyboardEvent } from "react";

import { PluginIcon } from "@/domains/intelligence/components/plugins/plugin-icon";
import { UpdateAvailableBadge } from "@/domains/intelligence/components/plugins/update-available-badge";
import { PLUGIN_TOGGLE_SEGMENTS } from "@/domains/intelligence/plugins/constants";
import type { PluginListItem } from "@/domains/intelligence/plugins/types";
import type { PluginDrift } from "@/domains/intelligence/use-plugin-drift";
import { Button, Card, SegmentControl } from "@vellumai/design-library";

interface PluginListRowProps {
  item: PluginListItem;
  /** Inspect result for the installed copy; owned by the tab, passed in so
   *  the row stays presentational. Gates the upgrade affordance. */
  drift?: PluginDrift;
  onSelect: () => void;
  onInstall?: () => void;
  onRemove?: () => void;
  onUpgrade?: () => void;
  /** Enable/disable the installed plugin. Wired only when the daemon supports
   *  toggling (older daemons omit `enabled`, so no switch renders). */
  onToggle?: (nextEnabled: boolean) => void;
  isInstalling?: boolean;
  isRemoving?: boolean;
  isUpgrading?: boolean;
  isToggling?: boolean;
}

/**
 * Unified row for the Plugins tab, mirroring `SkillRow`. The whole row is a
 * `role="button"` that fires `onSelect`; every trailing control
 * `stopPropagation`s so it never also selects the row.
 */
export function PluginListRow({
  item,
  drift,
  onSelect,
  onInstall,
  onRemove,
  onUpgrade,
  onToggle,
  isInstalling = false,
  isRemoving = false,
  isUpgrading = false,
  isToggling = false,
}: PluginListRowProps) {
  const available = item.status === "available";
  const updateAvailable = drift?.status === "update-available";
  const showToggle = onToggle !== undefined && item.enabled !== undefined;
  const dimmed = item.enabled === false;

  const handleRowKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Ignore key events bubbling up from a focused inline action button —
    // otherwise Enter/Space on Install/Remove/Upgrade would also select the row.
    if (e.target !== e.currentTarget) return;
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
        className="flex cursor-pointer items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <PluginIcon
          size="sm"
          external={item.external}
          className={dimmed ? "opacity-50" : undefined}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="truncate text-body-medium-default"
              style={{
                color: dimmed
                  ? "var(--content-tertiary)"
                  : "var(--content-emphasised)",
              }}
            >
              {item.name}
            </span>
            {item.version ? (
              <span
                className="shrink-0 text-body-small-default"
                style={{ color: "var(--content-tertiary)" }}
              >
                v{item.version}
              </span>
            ) : null}
            {/* No origin badge here: the installed-list endpoint carries no
                source, so a list row can't tell Local from External. The detail
                view derives origin from the plugin's own `source` instead. */}
            {/* The chip is the Upgrade control; it shows on any drift,
                regardless of Active/Off. */}
            {updateAvailable ? (
              <UpdateAvailableBadge
                onClick={onUpgrade}
                isUpgrading={isUpgrading}
              />
            ) : null}
          </div>
          <p
            className="mt-1 truncate text-body-medium-lighter"
            style={{ color: "var(--content-tertiary)" }}
          >
            {item.description ?? "No description provided."}
          </p>
          {item.issues && item.issues.length > 0 ? (
            <p
              className="mt-1 truncate text-body-small-default"
              style={{ color: "var(--content-warning, var(--content-tertiary))" }}
              title={item.issues.join("; ")}
            >
              {item.issues[0]}
              {item.issues.length > 1
                ? ` (+${item.issues.length - 1} more)`
                : ""}
            </p>
          ) : null}
        </div>

        {available ? (
          isInstalling ? (
            <Button
              type="button"
              iconOnly={<Loader2 className="animate-spin" aria-hidden />}
              disabled
              aria-label="Installing"
              expandOnMobile={false}
            />
          ) : (
            <Button
              type="button"
              iconOnly={<ArrowDownToLine aria-hidden />}
              onClick={(e) => {
                e.stopPropagation();
                onInstall?.();
              }}
              disabled={!onInstall}
              aria-label="Install plugin"
              expandOnMobile={false}
            />
          )
        ) : (
          // Installed: Active/Off control beside an always-present Remove (Upgrade
          // lives in the version-line chip), so the pair never shifts.
          <div className="flex shrink-0 items-center gap-2">
            {showToggle ? (
              // Wrap to stopPropagation: the row is a role="button" and would
              // otherwise select when a segment is clicked.
              <span
                className="inline-flex items-center"
                onClick={(e) => e.stopPropagation()}
              >
                <SegmentControl
                  className="w-auto [&_[role=radio]]:flex-none [&_[role=radio]]:text-body-large-default"
                  items={PLUGIN_TOGGLE_SEGMENTS.map((s) => ({
                    ...s,
                    disabled: isToggling,
                  }))}
                  value={item.enabled ? "active" : "off"}
                  onChange={(next) => onToggle?.(next === "active")}
                  ariaLabel={`Turn ${item.name} on or off`}
                />
              </span>
            ) : null}
            <Button
              type="button"
              variant="dangerOutline"
              iconOnly={
                isRemoving ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Trash2 aria-hidden />
                )
              }
              onClick={(e) => {
                e.stopPropagation();
                onRemove?.();
              }}
              disabled={isRemoving || isUpgrading || !onRemove}
              aria-label="Remove plugin"
              expandOnMobile={false}
            />
          </div>
        )}
      </div>
    </Card.Root>
  );
}
