import {
    ArrowDownToLine,
    ArrowUpCircle,
    Download,
    ExternalLink,
    Loader2,
    Trash2,
    TriangleAlert,
} from "lucide-react";
import { useState } from "react";

import {
    PLUGIN_INSTALL_ERROR,
    PLUGIN_REMOVE_ERROR,
    PLUGIN_UPGRADE_ERROR,
    pluginRemoveConfirmMessage,
    pluginRiskyUpgradeConfirmLabel,
    pluginRiskyUpgradeConfirmMessage,
} from "@/domains/intelligence/plugins/constants";
import { shortSha } from "@/domains/intelligence/plugins/utils";
import type { PluginDrift } from "@/domains/intelligence/use-plugin-drift";
import type { PluginsByNameGetResponse } from "@/generated/daemon/types.gen";
import { cn } from "@/utils/misc";
import { Button, ConfirmDialog, Toggle } from "@vellumai/design-library";

/**
 * Presentational building blocks shared by the plugin detail surfaces so the
 * metadata table, loading / error states, and the Install / Download / Upgrade
 * / Remove action set don't drift between them. These take props (plugin +
 * drift + callbacks) and render UI only — data fetching stays in the consuming
 * panel via `usePluginDetail`.
 *
 * The desktop in-tab detail (`plugin-detail.tsx`) and the mobile detail overlay
 * (`plugin-detail-mobile.tsx`) each place these pieces in their own layout
 * chrome, so the building blocks stay layout-agnostic.
 */

interface PluginDetailMetadataProps {
  plugin: PluginsByNameGetResponse;
  /**
   * Contributed-surface counts for an installed copy (skills / hooks / tools).
   * Only present once the drift inspection resolves; omit for surfaces we don't
   * track on this view.
   */
  surfaces?: PluginDrift["surfaces"];
  className?: string;
}

/**
 * Metadata table for a plugin: Source (repo link), Homepage, License, and —
 * when an installed copy's contributed surfaces are known — Skills / Hooks /
 * Tools counts. Only non-empty rows render.
 */
export function PluginDetailMetadata({
  plugin,
  surfaces = null,
  className,
}: PluginDetailMetadataProps) {
  const repo = plugin.source?.kind === "github" ? plugin.source.repo : "Local";
  const repoHref =
    plugin.source?.kind === "github"
      ? `https://github.com/${plugin.source.repo}`
      : null;

  const rows: { label: string; value: string; href?: string }[] = [
    {
      label: "Source",
      value: repo,
      href: repoHref ?? undefined,
    },
  ];
  if (plugin.homepage) {
    rows.push({
      label: "Homepage",
      value: plugin.homepage,
      href: plugin.homepage,
    });
  }
  if (plugin.license) {
    rows.push({ label: "License", value: plugin.license });
  }
  // Surfaces are only present for an installed copy; list the non-empty
  // contributions (skills / hooks / tools) so the panel shows what the
  // plugin actually adds.
  if (surfaces) {
    if (surfaces.skills.length > 0) {
      rows.push({ label: "Skills", value: String(surfaces.skills.length) });
    }
    if (surfaces.hooks.length > 0) {
      rows.push({ label: "Hooks", value: String(surfaces.hooks.length) });
    }
    if (surfaces.tools.length > 0) {
      rows.push({ label: "Tools", value: String(surfaces.tools.length) });
    }
  }

  return (
    <dl
      className={cn(
        "mb-5 grid gap-x-6 gap-y-2 border-b pb-5 sm:grid-cols-[max-content_1fr]",
        className,
      )}
      style={{ borderColor: "var(--border-base)" }}
    >
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt
            className="text-body-small-default"
            style={{ color: "var(--content-tertiary)" }}
          >
            {row.label}
          </dt>
          <dd
            className="min-w-0 truncate text-body-small-default"
            style={{ color: "var(--content-secondary)" }}
          >
            {row.href ? (
              <a
                href={row.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline"
                style={{ color: "var(--primary-base, #60a5fa)" }}
              >
                {row.value}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            ) : (
              row.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

interface PluginDetailActionsProps {
  plugin: PluginsByNameGetResponse;
  drift: PluginDrift | undefined;
  /** Install the available plugin. */
  onInstall: () => void;
  /** Remove the installed plugin (the confirm prompt is wired internally). */
  onRemove: () => void;
  /**
   * Upgrade the installed copy. A locally-edited copy is confirmed first (the
   * risky-upgrade prompt is wired internally); a clean copy upgrades directly.
   */
  onUpgrade: () => void;
  isInstalling: boolean;
  isRemoving: boolean;
  isUpgrading: boolean;
  /** Gates whether an upgrade prompts before overwriting local edits. */
  hasLocalEdits: boolean;
  /** Active state of the installed copy; `undefined` hides the Active/Off toggle (see `PluginListItem.enabled`). */
  enabled?: boolean;
  /** Flip the plugin's active state (optimistic, no confirm dialog). */
  onToggle?: () => void;
  isToggling?: boolean;
}

/**
 * Action set for a plugin: Install when available, otherwise Download-artifact
 * (when one ships), Upgrade (when an installed copy has drifted), and Remove.
 * Remove always confirms; Upgrade confirms only when the copy has local edits
 * that the re-install would clobber. The confirm dialogs are portal-rendered,
 * so callers can place this anywhere without affecting layout.
 */
export function PluginDetailActions({
  plugin,
  drift,
  onInstall,
  onRemove,
  onUpgrade,
  isInstalling,
  isRemoving,
  isUpgrading,
  hasLocalEdits,
  enabled,
  onToggle,
  isToggling,
}: PluginDetailActionsProps) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [confirmingUpgrade, setConfirmingUpgrade] = useState(false);

  const installed = plugin.installed ?? false;
  const artifact = plugin.artifact ?? null;
  const updateAvailable = drift?.status === "update-available";
  const upgradeTitle = updateAvailable
    ? `Upgrade ${shortSha(drift?.local?.commit ?? null)} → ${shortSha(
        drift?.remote?.commit ?? null,
      )}`
    : undefined;

  const confirmRemove = () => {
    setConfirmingRemove(false);
    onRemove();
  };

  // Local edits would be clobbered by the re-install, so confirm first;
  // a clean copy upgrades directly.
  const handleUpgrade = () => {
    if (hasLocalEdits) {
      setConfirmingUpgrade(true);
      return;
    }
    onUpgrade();
  };

  const confirmUpgrade = () => {
    setConfirmingUpgrade(false);
    onUpgrade();
  };

  return (
    <>
      {installed ? (
        // Wrap on narrow (mobile overlay) widths so a Download + Upgrade +
        // Remove set can't push actions off-screen; single row on desktop.
        <div className="flex flex-wrap items-center gap-2 md:flex-nowrap md:shrink-0">
          {/* Active/Off toggle leads the cluster (mirrors the MCP card). Hidden
              when enablement is unknown — an older daemon or a deep-link with no
              list row to source it from. Optimistic, so no confirm dialog. */}
          {enabled !== undefined && onToggle ? (
            <div className="flex items-center gap-2">
              <Toggle
                checked={enabled}
                onChange={onToggle}
                disabled={isToggling}
                aria-label={`${enabled ? "Deactivate" : "Activate"} ${plugin.name}`}
              />
              <span
                className="text-body-small-default"
                style={{ color: "var(--content-tertiary)" }}
              >
                {enabled ? "Active" : "Off"}
              </span>
            </div>
          ) : null}
          {artifact ? (
            <Button asChild leftIcon={<Download aria-hidden />}>
              <a href={artifact.url} download>
                {artifact.label ?? "Download"}
              </a>
            </Button>
          ) : null}
          {updateAvailable ? (
            <Button
              type="button"
              onClick={handleUpgrade}
              disabled={isUpgrading}
              title={upgradeTitle}
              leftIcon={
                isUpgrading ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <ArrowUpCircle aria-hidden />
                )
              }
            >
              Upgrade
            </Button>
          ) : null}
          <Button
            type="button"
            variant="dangerOutline"
            onClick={() => setConfirmingRemove(true)}
            disabled={isRemoving}
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
        </div>
      ) : (
        <Button
          type="button"
          onClick={onInstall}
          disabled={isInstalling}
          leftIcon={
            isInstalling ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <ArrowDownToLine aria-hidden />
            )
          }
        >
          Install
        </Button>
      )}

      <ConfirmDialog
        open={confirmingRemove}
        title="Remove plugin"
        message={pluginRemoveConfirmMessage(plugin.name)}
        confirmLabel="Remove"
        destructive
        onConfirm={confirmRemove}
        onCancel={() => setConfirmingRemove(false)}
      />

      <ConfirmDialog
        open={confirmingUpgrade}
        title="Upgrade plugin"
        message={pluginRiskyUpgradeConfirmMessage(plugin.name)}
        confirmLabel={pluginRiskyUpgradeConfirmLabel}
        destructive
        onConfirm={confirmUpgrade}
        onCancel={() => setConfirmingUpgrade(false)}
      />
    </>
  );
}

export function PluginDetailLoading() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2
        className="h-6 w-6 animate-spin"
        style={{ color: "var(--content-tertiary)" }}
      />
    </div>
  );
}

export function PluginDetailError() {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 py-12 text-center"
      style={{ color: "var(--content-tertiary)" }}
    >
      <TriangleAlert className="h-6 w-6" aria-hidden />
      <p className="text-body-medium-default">
        We couldn&apos;t load this plugin.
      </p>
      <p className="text-body-small-default">
        It may not exist, or your assistant may be on an older build.
      </p>
    </div>
  );
}

/**
 * Inline banner for a failed install / remove / upgrade attempt. Derives the
 * message from the three error flags so the desktop and mobile detail surfaces
 * stay in lockstep. Render it only when one of the flags is set.
 */
export function PluginDetailActionError({
  isInstallError,
  isRemoveError,
  isUpgradeError,
}: {
  isInstallError: boolean;
  isRemoveError: boolean;
  isUpgradeError: boolean;
}) {
  const message = isInstallError
    ? PLUGIN_INSTALL_ERROR
    : isRemoveError
      ? PLUGIN_REMOVE_ERROR
      : isUpgradeError
        ? PLUGIN_UPGRADE_ERROR
        : null;

  if (!message) return null;

  return (
    <div
      className="mb-3 flex items-center gap-2 rounded px-3 py-2 text-body-small-default"
      style={{
        backgroundColor: "var(--surface-secondary)",
        color: "var(--content-warning, var(--content-tertiary))",
      }}
      role="alert"
    >
      <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
      {message}
    </div>
  );
}
