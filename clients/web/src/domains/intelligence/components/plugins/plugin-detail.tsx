import {
    ArrowDownToLine,
    ArrowLeft,
    ArrowUpCircle,
    Download,
    ExternalLink,
    Loader2,
    Trash2,
    TriangleAlert,
} from "lucide-react";
import { useState } from "react";

import { FileMarkdown } from "@/components/file-markdown";
import { PluginIcon } from "@/domains/intelligence/components/plugins/plugin-icon";
import { PluginOriginBadge } from "@/domains/intelligence/components/plugins/plugin-origin-badge";
import { UpdateAvailableBadge } from "@/domains/intelligence/components/plugins/update-available-badge";
import {
    shortSha,
    usePluginDetail,
} from "@/domains/intelligence/plugins/use-plugin-detail";
import type { PluginDrift } from "@/domains/intelligence/use-plugin-drift";
import type { PluginsByNameGetResponse } from "@/generated/daemon/types.gen";
import { Button, Card, ConfirmDialog } from "@vellumai/design-library";

interface PluginDetailProps {
  assistantId: string;
  name: string;
  /** Leave the detail view (return to the plugins list). */
  onBack: () => void;
}

/**
 * In-tab detail panel for a single plugin, mirroring the Skills tab's
 * `SkillDetail` chrome (a back-button header + a `Card` body). Unlike the
 * retired `PluginDetailPage`, this is callback-driven with no routing: the
 * parent owns selection and passes `onBack` to close the panel. Removal
 * closes via `usePluginDetail`'s `onRemoved` hook.
 *
 * Renders the plugin's README plus the metadata we track (source, homepage,
 * license, contributed surfaces) and Install / Download / Upgrade / Remove
 * actions. Plugins have no file-list endpoint, so there is no file tree —
 * README + metadata only.
 */
export function PluginDetail({ assistantId, name, onBack }: PluginDetailProps) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [confirmingUpgrade, setConfirmingUpgrade] = useState(false);

  const {
    plugin,
    drift,
    isLoading,
    isError,
    install,
    remove,
    upgrade,
    isInstalling,
    isRemoving,
    isUpgrading,
    isInstallError,
    isRemoveError,
    isUpgradeError,
    hasLocalEdits,
  } = usePluginDetail(assistantId, name, { onRemoved: onBack });

  const confirmRemove = () => {
    setConfirmingRemove(false);
    remove();
  };

  // Local edits would be clobbered by the re-install, so confirm first;
  // a clean copy upgrades directly.
  const handleUpgrade = () => {
    if (hasLocalEdits) {
      setConfirmingUpgrade(true);
      return;
    }
    upgrade();
  };

  const confirmUpgrade = () => {
    setConfirmingUpgrade(false);
    upgrade();
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="mb-4 flex items-start gap-3">
        <Button
          type="button"
          variant="ghost"
          iconOnly={<ArrowLeft aria-hidden />}
          aria-label="Back to plugins"
          onClick={onBack}
        />
        <Header
          name={name}
          plugin={plugin}
          drift={drift}
          onInstall={install}
          onRemove={() => setConfirmingRemove(true)}
          onUpgrade={handleUpgrade}
          isInstalling={isInstalling}
          isRemoving={isRemoving}
          isUpgrading={isUpgrading}
        />
      </div>

      {(isInstallError || isRemoveError || isUpgradeError) && (
        <ActionError
          message={
            isInstallError
              ? "Failed to install plugin. Please try again."
              : isRemoveError
                ? "Failed to remove plugin. Please try again."
                : "Failed to upgrade plugin. Please try again."
          }
        />
      )}

      <Card.Root asChild>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {isLoading ? (
            <LoadingState />
          ) : isError || !plugin ? (
            <DetailErrorState />
          ) : (
            <>
              <Metadata plugin={plugin} surfaces={drift?.surfaces ?? null} />
              {plugin.readme ? (
                <FileMarkdown content={plugin.readme} />
              ) : (
                <p
                  className="text-body-medium-lighter"
                  style={{ color: "var(--content-tertiary)" }}
                >
                  This plugin doesn&apos;t ship a README.
                </p>
              )}
            </>
          )}
        </div>
      </Card.Root>

      <ConfirmDialog
        open={confirmingRemove}
        title="Remove plugin"
        message={`Remove "${plugin?.name ?? name}" from this assistant?`}
        confirmLabel="Remove"
        destructive
        onConfirm={confirmRemove}
        onCancel={() => setConfirmingRemove(false)}
      />

      <ConfirmDialog
        open={confirmingUpgrade}
        title="Upgrade plugin"
        message={`"${plugin?.name ?? name}" has local edits that will be overwritten by the upgrade. Continue?`}
        confirmLabel="Upgrade anyway"
        destructive
        onConfirm={confirmUpgrade}
        onCancel={() => setConfirmingUpgrade(false)}
      />
    </div>
  );
}

interface HeaderProps {
  name: string;
  plugin: PluginsByNameGetResponse | null;
  drift: PluginDrift | undefined;
  onInstall: () => void;
  onRemove: () => void;
  onUpgrade: () => void;
  isInstalling: boolean;
  isRemoving: boolean;
  isUpgrading: boolean;
}

function Header({
  name,
  plugin,
  drift,
  onInstall,
  onRemove,
  onUpgrade,
  isInstalling,
  isRemoving,
  isUpgrading,
}: HeaderProps) {
  const installed = plugin?.installed ?? false;
  const isExternal = plugin?.source?.kind === "github";
  const artifact = plugin?.artifact ?? null;
  const updateAvailable = drift?.status === "update-available";
  const upgradeTitle = updateAvailable
    ? `Upgrade ${shortSha(drift?.local?.commit ?? null)} → ${shortSha(
        drift?.remote?.commit ?? null,
      )}`
    : undefined;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <PluginIcon external={isExternal} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2
              className="text-title-medium"
              style={{ color: "var(--content-default)" }}
            >
              {plugin?.name ?? name}
            </h2>
            {plugin?.version ? (
              <span
                className="shrink-0 text-body-small-default"
                style={{ color: "var(--content-tertiary)" }}
              >
                v{plugin.version}
              </span>
            ) : null}
            {plugin ? <PluginOriginBadge external={isExternal} /> : null}
            {updateAvailable ? <UpdateAvailableBadge /> : null}
          </div>
          {plugin?.description ? (
            <p
              className="mt-0.5 line-clamp-2 text-body-medium-lighter"
              style={{ color: "var(--content-secondary)" }}
            >
              {plugin.description}
            </p>
          ) : null}
        </div>
      </div>

      {plugin ? (
        installed ? (
          <div className="flex shrink-0 items-center gap-2">
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
                onClick={onUpgrade}
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
              onClick={onRemove}
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
        )
      ) : null}
    </div>
  );
}

function Metadata({
  plugin,
  surfaces,
}: {
  plugin: PluginsByNameGetResponse;
  surfaces: PluginDrift["surfaces"];
}) {
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
      className="mb-5 grid gap-x-6 gap-y-2 border-b pb-5 sm:grid-cols-[max-content_1fr]"
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

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2
        className="h-6 w-6 animate-spin"
        style={{ color: "var(--content-tertiary)" }}
      />
    </div>
  );
}

function DetailErrorState() {
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

function ActionError({ message }: { message: string }) {
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
