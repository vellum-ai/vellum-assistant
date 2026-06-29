import {
    ArrowDownToLine,
    ArrowLeft,
    ArrowUpCircle,
    ExternalLink,
    Loader2,
    Trash2,
    TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { FileMarkdown } from "@/components/file-markdown";
import { PluginIcon } from "@/domains/intelligence/components/plugins/plugin-icon";
import { PluginOriginBadge } from "@/domains/intelligence/components/plugins/plugin-origin-badge";
import { UpdateAvailableBadge } from "@/domains/intelligence/components/plugins/update-available-badge";
import { usePluginDetail } from "@/domains/intelligence/plugins/use-plugin-detail";
import type { PluginsByNameGetResponse } from "@/generated/daemon/types.gen";
import { Button, Card, ConfirmDialog } from "@vellumai/design-library";

interface PluginDetailMobileProps {
  assistantId: string;
  name: string;
  onBack: () => void;
}

/**
 * Single-column phone layout for viewing a plugin's details.
 *
 * Renders as a full-screen overlay that takes over the whole viewport — its own
 * back · title · action bar replaces the app's mobile chrome and the
 * Intelligence tab row, mirroring `SkillDetailMobile`. The overlay is portaled
 * into `RootLayout`'s `#viewport-overlays` container so a transformed layout
 * ancestor can't scope its `position: fixed`; when the target isn't resolved
 * yet (first paint / tests) it falls back to rendering inline.
 *
 * Unlike skills, plugins expose no file endpoints, so the content card is just
 * the tracked metadata plus the README. Owns the install / remove / upgrade
 * flow via `usePluginDetail`, returning to the list (`onBack`) once the plugin
 * is removed. Removing — and upgrading a locally-edited copy — confirm first.
 */
export function PluginDetailMobile({
  assistantId,
  name,
  onBack,
}: PluginDetailMobileProps) {
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
    hasLocalEdits,
  } = usePluginDetail(assistantId, name, { onRemoved: onBack });

  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [confirmingUpgrade, setConfirmingUpgrade] = useState(false);

  // Resolve the full-screen portal target after commit (SSR-safe; the element
  // is mounted by RootLayout). Falls back to inline when absent (tests, first
  // paint).
  const [overlayTarget, setOverlayTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setOverlayTarget(document.getElementById("viewport-overlays"));
  }, []);

  const isExternal = plugin?.source?.kind === "github";
  const installed = plugin?.installed ?? false;
  const updateAvailable = drift?.status === "update-available";
  const title = plugin?.name ?? name;

  const confirmRemove = () => {
    setConfirmingRemove(false);
    remove();
  };

  // Local edits would be clobbered by the re-install, so confirm first; a clean
  // copy upgrades directly.
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

  const overlay = (
    <div
      className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-[var(--surface-overlay)]"
      style={{
        paddingTop:
          "calc(8px + var(--safe-area-inset-top, env(safe-area-inset-top, 0px)))",
        paddingBottom:
          "calc(8px + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
        paddingLeft:
          "calc(12px + var(--safe-area-inset-left, env(safe-area-inset-left, 0px)))",
        paddingRight:
          "calc(12px + var(--safe-area-inset-right, env(safe-area-inset-right, 0px)))",
      }}
    >
      {/* Action bar */}
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          iconOnly={<ArrowLeft aria-hidden />}
          expandOnMobile
          aria-label="Back to plugins"
          onClick={onBack}
          className="max-md:bg-[var(--surface-active)]"
        />
        <span
          className="min-w-0 flex-1 truncate px-2 text-center text-body-medium-default"
          style={{ color: "var(--content-secondary)" }}
        >
          {title}
        </span>
        <RightAction
          hasPlugin={plugin !== null}
          installed={installed}
          updateAvailable={updateAvailable}
          isInstalling={isInstalling}
          isRemoving={isRemoving}
          isUpgrading={isUpgrading}
          onInstall={install}
          onRemove={() => setConfirmingRemove(true)}
          onUpgrade={handleUpgrade}
        />
      </div>

      {/* Header block — 16px below the action bar */}
      <div className="mt-4 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <PluginIcon external={isExternal} size="md" />
            <h2
              className="min-w-0 truncate text-title-medium"
              style={{ color: "var(--content-emphasised)" }}
            >
              {title}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {updateAvailable ? <UpdateAvailableBadge /> : null}
            <PluginOriginBadge external={isExternal} />
          </div>
        </div>
        {plugin?.description ? (
          <p
            className="text-body-medium-lighter"
            style={{ color: "var(--content-tertiary)" }}
          >
            {plugin.description}
          </p>
        ) : null}
      </div>

      {/* Content card — 24px below the description */}
      <Card.Root asChild noPadding>
        <div
          className="mt-6 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-[var(--surface-lift)]"
          style={{ borderColor: "var(--border-hover)" }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {isLoading ? (
              <LoadingState />
            ) : isError || !plugin ? (
              <DetailErrorState />
            ) : (
              <>
                <Metadata plugin={plugin} />
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
        </div>
      </Card.Root>

      <ConfirmDialog
        open={confirmingRemove}
        title="Remove plugin"
        message={`Remove "${title}" from this assistant?`}
        confirmLabel="Remove"
        destructive
        onConfirm={confirmRemove}
        onCancel={() => setConfirmingRemove(false)}
      />

      <ConfirmDialog
        open={confirmingUpgrade}
        title="Upgrade plugin"
        message={`"${title}" has local edits that will be overwritten by the upgrade. Continue?`}
        confirmLabel="Upgrade anyway"
        destructive
        onConfirm={confirmUpgrade}
        onCancel={() => setConfirmingUpgrade(false)}
      />
    </div>
  );

  return overlayTarget ? createPortal(overlay, overlayTarget) : overlay;
}

function RightAction({
  hasPlugin,
  installed,
  updateAvailable,
  isInstalling,
  isRemoving,
  isUpgrading,
  onInstall,
  onRemove,
  onUpgrade,
}: {
  hasPlugin: boolean;
  installed: boolean;
  updateAvailable: boolean;
  isInstalling: boolean;
  isRemoving: boolean;
  isUpgrading: boolean;
  onInstall: () => void;
  onRemove: () => void;
  onUpgrade: () => void;
}) {
  if (!hasPlugin) {
    return null;
  }

  if (isInstalling || isRemoving || isUpgrading) {
    return (
      <Button
        variant="ghost"
        iconOnly={<Loader2 className="animate-spin" aria-hidden />}
        expandOnMobile
        disabled
        aria-label="Pending"
        className="max-md:bg-[var(--surface-active)]"
      />
    );
  }

  if (!installed) {
    return (
      <Button
        variant="ghost"
        iconOnly={<ArrowDownToLine aria-hidden />}
        expandOnMobile
        aria-label="Install plugin"
        onClick={onInstall}
        className="max-md:bg-[var(--surface-active)]"
      />
    );
  }

  if (updateAvailable) {
    return (
      <Button
        variant="ghost"
        iconOnly={<ArrowUpCircle aria-hidden />}
        expandOnMobile
        aria-label="Upgrade plugin"
        onClick={onUpgrade}
        className="max-md:bg-[var(--surface-active)]"
      />
    );
  }

  return (
    <Button
      variant="dangerGhost"
      iconOnly={<Trash2 aria-hidden />}
      expandOnMobile
      aria-label="Remove plugin"
      onClick={onRemove}
      className="max-md:rounded-full max-md:bg-[var(--system-negative-weak)]"
    />
  );
}

function Metadata({ plugin }: { plugin: PluginsByNameGetResponse }) {
  const repo = plugin.source?.kind === "github" ? plugin.source.repo : "Local";
  const repoHref =
    plugin.source?.kind === "github"
      ? `https://github.com/${plugin.source.repo}`
      : null;

  const rows: { label: string; value: string; href?: string }[] = [
    { label: "Source", value: repo, href: repoHref ?? undefined },
  ];
  if (plugin.version) {
    rows.push({ label: "Version", value: `v${plugin.version}` });
  }
  if (plugin.homepage) {
    rows.push({ label: "Homepage", value: plugin.homepage, href: plugin.homepage });
  }
  if (plugin.license) {
    rows.push({ label: "License", value: plugin.license });
  }

  return (
    <dl
      className="mb-5 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 border-b pb-5"
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
