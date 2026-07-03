import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { FileMarkdown } from "@/components/file-markdown";
import { PluginIcon } from "@/domains/intelligence/components/plugins/plugin-icon";
import {
    PluginDetailActionError,
    PluginDetailActions,
    PluginDetailError,
    PluginDetailLoading,
    PluginDetailMetadata,
} from "@/domains/intelligence/components/plugins/plugin-detail-shared";
import { PluginOriginBadge } from "@/domains/intelligence/components/plugins/plugin-origin-badge";
import { UpdateAvailableBadge } from "@/domains/intelligence/components/plugins/update-available-badge";
import { usePluginDetail } from "@/domains/intelligence/plugins/use-plugin-detail";
import { usePluginToggle } from "@/domains/intelligence/plugins/use-plugin-toggle";
import { Button, Card } from "@vellumai/design-library";

interface PluginDetailMobileProps {
  assistantId: string;
  name: string;
  onBack: () => void;
  /**
   * Known external state from the selected list row, used to seed the header
   * icon before the detail query resolves so click-through shows the right
   * glyph immediately. `undefined` for deep-links with no matching row.
   */
  externalHint?: boolean;
  /** Active/Off state seeded from the selected list row (see `PluginListItem.enabled`); `undefined` hides the toggle. */
  enabled?: boolean;
}

/**
 * Single-column phone layout for viewing a plugin's details.
 *
 * Renders as a full-screen overlay that takes over the whole viewport — its own
 * back · title action bar replaces the app's mobile chrome and the Intelligence
 * tab row, mirroring `SkillDetailMobile`. The overlay is portaled into
 * `RootLayout`'s `#viewport-overlays` container so a transformed layout ancestor
 * can't scope its `position: fixed`; when the target isn't resolved yet (first
 * paint / tests) it falls back to rendering inline.
 *
 * Unlike skills, plugins expose no file endpoints, so the content card is just
 * the tracked metadata plus the README. The metadata table, loading / error
 * states, and the Install / Download / Upgrade / Remove action set all come from
 * `plugin-detail-shared` so they stay in lockstep with the desktop detail. The
 * shared action set renders Upgrade *and* Remove together when an update is
 * available, so an update never hides the uninstall path on mobile. Owns the
 * install / remove / upgrade flow via `usePluginDetail`, returning to the list
 * (`onBack`) once the plugin is removed.
 */
export function PluginDetailMobile({
  assistantId,
  name,
  onBack,
  externalHint,
  enabled,
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
    isInstallError,
    isRemoveError,
    isUpgradeError,
    hasLocalEdits,
  } = usePluginDetail(assistantId, name, { onRemoved: onBack });
  const { toggle, togglingName } = usePluginToggle(assistantId);

  // Resolve the full-screen portal target after commit (SSR-safe; the element
  // is mounted by RootLayout). Falls back to inline when absent (tests, first
  // paint).
  const [overlayTarget, setOverlayTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setOverlayTarget(document.getElementById("viewport-overlays"));
  }, []);

  const isExternal = plugin?.source?.kind === "github";
  // Gate the header icon on the loaded plugin, seeding the known external state
  // from the selected list row, so we never flash a wrong glyph (🧩 → 📦) while
  // the detail query is still loading. `undefined` until we know either.
  const resolvedExternal = plugin ? isExternal : externalHint;
  const updateAvailable = drift?.status === "update-available";
  const title = plugin?.name ?? name;

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
      {/* Action bar — back + centered title. The trailing spacer mirrors the
          back button's footprint so the title stays optically centered. */}
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
        <span
          aria-hidden
          className="h-8 w-8 shrink-0 touch-mobile:h-10 touch-mobile:w-10"
        />
      </div>

      {/* Header block — 16px below the action bar */}
      <div className="mt-4 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {resolvedExternal === undefined ? (
              <span aria-hidden className="h-8 w-8 shrink-0" />
            ) : (
              <PluginIcon external={resolvedExternal} size="md" />
            )}
            <h2
              className="min-w-0 truncate text-title-medium"
              style={{ color: "var(--content-emphasised)" }}
            >
              {title}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {updateAvailable ? <UpdateAvailableBadge /> : null}
            {plugin ? <PluginOriginBadge external={isExternal} /> : null}
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

      {/* Action set — the full Install / Download / Upgrade / Remove set, so
          Remove stays reachable even when an update is available. */}
      {plugin ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <PluginDetailActions
            plugin={plugin}
            drift={drift}
            enabled={enabled}
            onToggle={() => toggle(name, !enabled)}
            isToggling={togglingName === name}
            onInstall={install}
            onRemove={remove}
            onUpgrade={upgrade}
            isInstalling={isInstalling}
            isRemoving={isRemoving}
            isUpgrading={isUpgrading}
            hasLocalEdits={hasLocalEdits}
          />
        </div>
      ) : null}

      {(isInstallError || isRemoveError || isUpgradeError) && (
        <div className="mt-3">
          <PluginDetailActionError
            isInstallError={isInstallError}
            isRemoveError={isRemoveError}
            isUpgradeError={isUpgradeError}
          />
        </div>
      )}

      {/* Content card — 24px below the action set */}
      <Card.Root asChild noPadding>
        <div
          className="mt-6 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-[var(--surface-lift)]"
          style={{ borderColor: "var(--border-hover)" }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {isLoading ? (
              <PluginDetailLoading />
            ) : isError || !plugin ? (
              <PluginDetailError />
            ) : (
              <>
                <PluginDetailMetadata
                  plugin={plugin}
                  surfaces={drift?.surfaces ?? null}
                />
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
    </div>
  );

  return overlayTarget ? createPortal(overlay, overlayTarget) : overlay;
}
