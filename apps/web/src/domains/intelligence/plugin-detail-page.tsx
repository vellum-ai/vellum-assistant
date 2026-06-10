import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    ArrowDownToLine,
    ArrowLeft,
    ExternalLink,
    Loader2,
    Trash2,
    TriangleAlert,
} from "lucide-react";
import { useCallback, useState } from "react";
import { Link, Navigate, useParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { FileMarkdown } from "@/components/file-markdown";
import {
    pluginsByNameDeleteMutation,
    pluginsByNameGetOptions,
    pluginsByNameGetQueryKey,
    pluginsGetQueryKey,
    pluginsInstallPostMutation,
    pluginsSearchGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { PluginsByNameGetResponse } from "@/generated/daemon/types.gen";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";
import { Button, Card, ConfirmDialog, toast } from "@vellumai/design-library";

/**
 * Detail page for a single plugin, reached by clicking a row in the
 * Plugins tab. Renders the plugin's README plus the metadata we track
 * (source, homepage, license, version) and an Install / Remove action.
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

  const detailQuery = useQuery({
    ...pluginsByNameGetOptions({
      path: { assistant_id: assistantId, name: name ?? "" },
    }),
    enabled: Boolean(assistantId) && Boolean(name),
  });

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
    }
  }, [assistantId, name, queryClient]);

  const installMutation = useMutation({
    ...pluginsInstallPostMutation(),
    onSuccess: () => {
      invalidate();
      toast.success(`Installed ${name ?? "plugin"}`);
    },
  });

  const removeMutation = useMutation({
    ...pluginsByNameDeleteMutation(),
    onSuccess: invalidate,
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
          onInstall={handleInstall}
          onRemove={() => setConfirmingRemove(true)}
          isInstalling={installMutation.isPending}
          isRemoving={removeMutation.isPending}
        />
      </div>

      {(installMutation.isError || removeMutation.isError) && (
        <ActionError
          message={
            installMutation.isError
              ? "Failed to install plugin. Please try again."
              : "Failed to remove plugin. Please try again."
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
    </div>
  );
}

interface HeaderProps {
  name: string;
  plugin: PluginsByNameGetResponse | null;
  onInstall: () => void;
  onRemove: () => void;
  isInstalling: boolean;
  isRemoving: boolean;
}

function Header({
  name,
  plugin,
  onInstall,
  onRemove,
  isInstalling,
  isRemoving,
}: HeaderProps) {
  const installed = plugin?.installed ?? false;
  const isExternal = plugin?.source?.kind === "github";

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
