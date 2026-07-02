import { ArrowLeft } from "lucide-react";

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
import { usePluginIconSrc } from "@/domains/intelligence/plugins/use-plugin-icon-src";
import { usePluginToggle } from "@/domains/intelligence/plugins/use-plugin-toggle";
import type { PluginDrift } from "@/domains/intelligence/use-plugin-drift";
import type { PluginsByNameGetResponse } from "@/generated/daemon/types.gen";
import { Button, Card } from "@vellumai/design-library";

interface PluginDetailProps {
  assistantId: string;
  name: string;
  /** Leave the detail view (return to the plugins list). */
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
 * In-tab detail panel for a single plugin, mirroring the Skills tab's
 * `SkillDetail` chrome (a back-button header + a `Card` body). It is
 * callback-driven with no routing: the parent owns selection and passes
 * `onBack` to close the panel. Removal closes via `usePluginDetail`'s
 * `onRemoved` hook.
 *
 * Renders the plugin's README plus the metadata we track (source, homepage,
 * license, contributed surfaces) and Install / Download / Upgrade / Remove
 * actions. The metadata table, state views, and action set come from
 * `plugin-detail-shared` so they stay in lockstep with the mobile detail.
 * Plugins have no file-list endpoint, so there is no file tree —
 * README + metadata only.
 */
export function PluginDetail({
  assistantId,
  name,
  onBack,
  externalHint,
  enabled,
}: PluginDetailProps) {
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

  const iconSrc = usePluginIconSrc(
    assistantId,
    name,
    plugin?.hasIcon,
    plugin?.iconVersion,
  );

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
          externalHint={externalHint}
          iconSrc={iconSrc}
          drift={drift}
          onInstall={install}
          onRemove={remove}
          onUpgrade={upgrade}
          isInstalling={isInstalling}
          isRemoving={isRemoving}
          isUpgrading={isUpgrading}
          hasLocalEdits={hasLocalEdits}
          enabled={enabled}
          onToggle={() => toggle(name, !enabled)}
          isToggling={togglingName === name}
        />
      </div>

      {(isInstallError || isRemoveError || isUpgradeError) && (
        <PluginDetailActionError
          isInstallError={isInstallError}
          isRemoveError={isRemoveError}
          isUpgradeError={isUpgradeError}
        />
      )}

      <Card.Root asChild>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
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
      </Card.Root>
    </div>
  );
}

interface HeaderProps {
  name: string;
  plugin: PluginsByNameGetResponse | null;
  externalHint?: boolean;
  /** Bundled-icon URL, gated + built by the parent; `undefined` → emoji/glyph. */
  iconSrc?: string;
  drift: PluginDrift | undefined;
  onInstall: () => void;
  onRemove: () => void;
  onUpgrade: () => void;
  isInstalling: boolean;
  isRemoving: boolean;
  isUpgrading: boolean;
  hasLocalEdits: boolean;
  enabled?: boolean;
  onToggle?: () => void;
  isToggling: boolean;
}

function Header({
  name,
  plugin,
  externalHint,
  iconSrc,
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
}: HeaderProps) {
  const isExternal = plugin?.source?.kind === "github";
  // Gate the header icon on the loaded plugin, seeding the known external state
  // from the selected list row, so we never flash a wrong glyph (🧩 → 📦) while
  // the detail query is still loading. `undefined` until we know either.
  const resolvedExternal = plugin ? isExternal : externalHint;
  const updateAvailable = drift?.status === "update-available";

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
      {/* Top-align the icon: the description loads asynchronously and grows the
          text block, so centering would nudge the icon down once it arrives. */}
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {resolvedExternal === undefined ? (
          <span aria-hidden className="h-8 w-8 shrink-0" />
        ) : (
          <PluginIcon
            external={resolvedExternal}
            icon={plugin?.icon ?? undefined}
            iconSrc={iconSrc}
            size="md"
          />
        )}
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
        <PluginDetailActions
          plugin={plugin}
          drift={drift}
          onInstall={onInstall}
          onRemove={onRemove}
          onUpgrade={onUpgrade}
          isInstalling={isInstalling}
          isRemoving={isRemoving}
          isUpgrading={isUpgrading}
          hasLocalEdits={hasLocalEdits}
          enabled={enabled}
          onToggle={onToggle}
          isToggling={isToggling}
        />
      ) : null}
    </div>
  );
}
