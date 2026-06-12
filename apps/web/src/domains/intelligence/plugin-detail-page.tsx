import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useCallback, useState } from "react";
import { Link, Navigate, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { FileMarkdown } from "@/components/file-markdown";
import { UpdateAvailableBadge } from "@/domains/intelligence/components/plugins/update-available-badge";
import {
    hasLocalEdits,
    type PluginDrift,
    usePluginDrift,
} from "@/domains/intelligence/use-plugin-drift";
import {
    pluginsByNameGetOptions,
    pluginsByNameGetQueryKey,
    pluginsByNameInspectGetQueryKey,
    pluginsGetQueryKey,
    pluginsSearchGetQueryKey,
    usePluginsByNameDeleteMutation,
    usePluginsByNameUpgradePostMutation,
    usePluginsInstallPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { PluginsByNameGetResponse } from "@/generated/daemon/types.gen";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";
import { Button, Card, ConfirmDialog, toast } from "@vellumai/design-library";

/** First 7 chars of a commit SHA, matching git's default short form. */
function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

/**
 * Detail page for a single plugin, reached by clicking a row in the
 * Plugins tab. Renders the plugin's README plus the metadata we track
 * (source, homepage, license, version) and Install / Upgrade / Remove
 * actions. When the installed copy is behind the marketplace pin, an
 * "Update available" badge and an Upgrade button appear; upgrading a
 * locally-edited copy prompts for confirmation first.
 *
 * Mounted under `IntelligenceLayout` so the "About Assistant" heading
 * and tab bar stay in place (the Plugins tab reads active via the
 * layout's `pathname.startsWith` check). Gated by the same
 * `external-plugins` feature flag as `PluginsPage` — a direct deep-link
 * with the flag off redirects back to Identity.
 */
export function PluginDetailPage() {
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const externalPlugins = useAssistantFeatureFlagStore.use.externalPlugins();
  const assistantId = useActiveAssistantId();
  const { name } = useParams<{ name: string }>();
  const queryClient = useQueryClient();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [confirmingUpgrade, setConfirmingUpgrade] = useState(false);

  const detailQuery = useQuery({
    ...pluginsByNameGetOptions({
      path: { assistant_id: assistantId, name: name ?? "" },
    }),
    enabled: Boolean(assistantId) && Boolean(name),
  });

  const installed = detailQuery.data?.installed ?? false;
  const driftQuery = usePluginDrift({
    assistantId,
    name: name ?? "",
    enabled: installed,
  });
  const drift = driftQuery.data;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: pluginsGetQueryKey({ path: { assistant_id: assistantId } }),
    });
    void queryClient.invalidateQueries({
      queryKey: pluginsSearchGetQueryKey({
        path: { assistant_id: assistantId },
      }),
    });
    if (name) {
      void queryClient.invalidateQueries({
        queryKey: pluginsByNameGetQueryKey({
          path: { assistant_id: assistantId, name },
        }),
      });
      void queryClient.invalidateQueries({
        queryKey: pluginsByNameInspectGetQueryKey({
          path: { assistant_id: assistantId, name },
        }),
      });
    }
  }, [assistantId, name, queryClient]);

  const installMutation = usePluginsInstallPostMutation({
    onSuccess: () => {
      invalidate();
      toast.success(`Installed ${name ?? "plugin"}`);
    },
  });

  const removeMutation = usePluginsByNameDeleteMutation({
    onSuccess: invalidate,
  });

  const upgradeMutation = usePluginsByNameUpgradePostMutation({
    onSuccess: (result) => {
      invalidate();
      toast.success(
        result.outcome === "already-up-to-date"
          ? `${name ?? "Plugin"} is already up to date`
          : `Upgraded ${name ?? "plugin"} to ${shortSha(result.toCommit)}`,
      );
    },
  });

  // Wait for the first /feature-flags response before deciding to
  // redirect, mirroring PluginsPage — rendering nothing for one frame
  // beats bouncing a user who genuinely has the flag enabled.
  if (!hasHydrated) {
    return null;
  }

  if (!externalPlugins) {
    return <Navigate to={routes.identity} replace />;
  }

  if (!name) {
    return <Navigate to={routes.plugins} replace />;
  }

  const handleInstall = () => {
    installMutation.mutate({
      path: { assistant_id: assistantId },
      body: { name },
    });
  };

  const confirmRemove = () => {
    setConfirmingRemove(false);
    removeMutation.mutate({
      path: { assistant_id: assistantId, name },
    });
  };

  const runUpgrade = () => {
    upgradeMutation.mutate({
      path: { assistant_id: assistantId, name },
      body: {},
    });
  };

  // Local edits would be clobbered by the re-install, so confirm first;
  // a clean copy upgrades directly.
  const handleUpgrade = () => {
    if (hasLocalEdits(drift)) {
      setConfirmingUpgrade(true);
      return;
    }
    runUpgrade();
  };

  const confirmUpgrade = () => {
    setConfirmingUpgrade(false);
    runUpgrade();
  };

  const plugin = detailQuery.data ?? null;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="mb-4 flex items-start gap-3">
        <Button asChild variant="ghost">
          <Link to={routes.plugins} aria-label="Back to plugins">
            <ArrowLeft aria-hidden />
          </Link>
        </Button>
        <Header
          name={name}
          plugin={plugin}
          drift={drift}
          onInstall={handleInstall}
          onRemove={() => setConfirmingRemove(true)}
          onUpgrade={handleUpgrade}
          isInstalling={installMutation.isPending}
          isRemoving={removeMutation.isPending}
          isUpgrading={upgradeMutation.isPending}
        />
      </div>

      {(installMutation.isError ||
        removeMutation.isError ||
        upgradeMutation.isError) && (
        <ActionError
          message={
            installMutation.isError
              ? "Failed to install plugin. Please try again."
              : removeMutation.isError
                ? "Failed to remove plugin. Please try again."
                : "Failed to upgrade plugin. Please try again."
          }
        />
      )}

      <Card.Root asChild>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {detailQuery.isLoading ? (
            <LoadingState />
          ) : detailQuery.isError || !plugin ? (
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
    ? `Upgrade ${shortSha(drift?.local?.commit ?? null)} \u2192 ${shortSha(
        drift?.remote?.commit ?? null,
      )}`
    : undefined;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center text-2xl">
          {isExternal ? "📦" : "🧩"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2
              className="truncate text-title-medium"
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
            {isExternal ? (
              <span
                className="shrink-0 rounded px-1.5 py-0.5 text-body-small-default"
                style={{
                  backgroundColor: "var(--surface-secondary)",
                  color: "var(--content-tertiary)",
                }}
              >
                external
              </span>
            ) : null}
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

function Metadata({ plugin }: { plugin: PluginsByNameGetResponse }) {
  const repo =
    plugin.source?.kind === "github" ? plugin.source.repo : "Local";
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
