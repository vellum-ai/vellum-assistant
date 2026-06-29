import { useQueryClient } from "@tanstack/react-query";
import {
    CheckCircle,
    CloudOff,
    Loader2,
    Puzzle,
    Sparkles,
    TriangleAlert,
    X,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { FilterBar } from "@/domains/intelligence/components/plugins/plugin-filters";
import { PluginListRow } from "@/domains/intelligence/components/plugins/plugin-list-row";
import type {
    PluginFilter,
    PluginListItem,
} from "@/domains/intelligence/plugins/types";
import { usePluginsList } from "@/domains/intelligence/plugins/use-plugins-list";
import {
    filterByStatus,
    matchesQuery,
} from "@/domains/intelligence/plugins/utils";
import {
    hasLocalEdits,
    type PluginDrift,
    usePluginDrift,
} from "@/domains/intelligence/use-plugin-drift";
import {
    pluginsByNameInspectGetQueryKey,
    pluginsGetQueryKey,
    pluginsSearchGetQueryKey,
    usePluginsByNameDeleteMutation,
    usePluginsByNameUpgradePostMutation,
    usePluginsInstallPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { getLocalBool, setLocalBool } from "@/utils/local-settings";
import { routes } from "@/utils/routes";
import { Button, Card, ConfirmDialog } from "@vellumai/design-library";

interface PluginsTabProps {
  assistantId: string;
}

const TIP_STORAGE_KEY = "vellum:plugins:tipDismissed";

/**
 * Plugins tab list view, mirroring `SkillsTab`: a dismissible tip, a search +
 * status-filter bar, and a single installed-first list of `PluginListRow`s.
 * Install / remove / upgrade live here (the rows are presentational) so the
 * tab can gate destructive Remove and local-edit-overwriting Upgrade behind a
 * `ConfirmDialog`. Selecting a row navigates to the existing detail route.
 */
export function PluginsTab({ assistantId }: PluginsTabProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [searchValue, setSearchValue] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");
  const [installingName, setInstallingName] = useState<string | null>(null);
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [upgradingName, setUpgradingName] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PluginListItem | null>(
    null,
  );
  const [pendingUpgrade, setPendingUpgrade] = useState<PluginListItem | null>(
    null,
  );
  const [tipDismissed, setTipDismissed] = useState(() =>
    getLocalBool(TIP_STORAGE_KEY, false),
  );

  const { items, isLoading, isError, isFetching, catalogError } =
    usePluginsList(assistantId);

  const invalidate = useCallback(
    (name: string) => {
      void queryClient.invalidateQueries({
        queryKey: pluginsGetQueryKey({ path: { assistant_id: assistantId } }),
      });
      void queryClient.invalidateQueries({
        queryKey: pluginsSearchGetQueryKey({
          path: { assistant_id: assistantId },
        }),
      });
      void queryClient.invalidateQueries({
        queryKey: pluginsByNameInspectGetQueryKey({
          path: { assistant_id: assistantId, name },
        }),
      });
    },
    [assistantId, queryClient],
  );

  const installMutation = usePluginsInstallPostMutation({
    onMutate: (variables) => setInstallingName(variables.body.name),
    onSettled: (_data, _error, variables) => {
      setInstallingName(null);
      invalidate(variables.body.name);
    },
  });

  const removeMutation = usePluginsByNameDeleteMutation({
    onMutate: (variables) => setRemovingName(variables.path.name),
    onSettled: (_data, _error, variables) => {
      setRemovingName(null);
      invalidate(variables.path.name);
    },
  });

  const upgradeMutation = usePluginsByNameUpgradePostMutation({
    onMutate: (variables) => setUpgradingName(variables.path.name),
    onSettled: (_data, _error, variables) => {
      setUpgradingName(null);
      invalidate(variables.path.name);
    },
  });

  const handleSelect = useCallback(
    (item: PluginListItem) => navigate(routes.plugin(item.name)),
    [navigate],
  );

  const handleInstall = useCallback(
    (item: PluginListItem) => {
      installMutation.mutate({
        path: { assistant_id: assistantId },
        body: { name: item.name },
      });
    },
    [assistantId, installMutation],
  );

  const confirmRemove = useCallback(() => {
    if (!pendingRemoval) return;
    removeMutation.mutate({
      path: { assistant_id: assistantId, name: pendingRemoval.name },
    });
    setPendingRemoval(null);
  }, [assistantId, pendingRemoval, removeMutation]);

  const runUpgrade = useCallback(
    (name: string) => {
      upgradeMutation.mutate({
        path: { assistant_id: assistantId, name },
        body: {},
      });
    },
    [assistantId, upgradeMutation],
  );

  const confirmUpgrade = useCallback(() => {
    if (!pendingUpgrade) return;
    runUpgrade(pendingUpgrade.name);
    setPendingUpgrade(null);
  }, [pendingUpgrade, runUpgrade]);

  // Upgrading directly overwrites the installed copy. When that copy has local
  // edits, gate behind a confirm dialog so the overwrite is intentional; the
  // drift comes from the per-row inspect, so the row hands it back up.
  const handleUpgrade = useCallback(
    (item: PluginListItem, drift: PluginDrift | undefined) => {
      if (hasLocalEdits(drift)) {
        setPendingUpgrade(item);
        return;
      }
      runUpgrade(item.name);
    },
    [runUpgrade],
  );

  const handleDismissTip = useCallback(() => {
    setTipDismissed(true);
    setLocalBool(TIP_STORAGE_KEY, true);
  }, []);

  const visibleItems = useMemo(
    () =>
      filterByStatus(items, filter).filter((item) =>
        matchesQuery(item, searchValue),
      ),
    [items, filter, searchValue],
  );

  const isSearching = isFetching && !isLoading;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
      {!tipDismissed && <TipBanner onDismiss={handleDismissTip} />}

      <FilterBar
        searchValue={searchValue}
        onSearchChange={setSearchValue}
        filter={filter}
        onFilterChange={setFilter}
        isSearching={isSearching}
      />

      {catalogError && !isLoading && !isError ? (
        <CatalogUnavailableNotice />
      ) : null}

      <div className="min-w-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <LoadingState />
        ) : isError ? (
          <ErrorState />
        ) : visibleItems.length === 0 ? (
          <EmptyState filter={filter} />
        ) : (
          <ul className="flex flex-col gap-2">
            {visibleItems.map((item) => (
              <li key={item.name}>
                {item.status === "installed" ? (
                  <InstalledPluginRow
                    assistantId={assistantId}
                    item={item}
                    onSelect={() => handleSelect(item)}
                    onRemove={() => setPendingRemoval(item)}
                    onUpgrade={(drift) => handleUpgrade(item, drift)}
                    isRemoving={removingName === item.name}
                    isUpgrading={upgradingName === item.name}
                  />
                ) : (
                  <PluginListRow
                    item={item}
                    onSelect={() => handleSelect(item)}
                    onInstall={() => handleInstall(item)}
                    isInstalling={installingName === item.name}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pendingRemoval !== null}
        title="Remove plugin"
        message={
          pendingRemoval
            ? `Remove "${pendingRemoval.name}" from this assistant?`
            : ""
        }
        confirmLabel="Remove"
        destructive
        onConfirm={confirmRemove}
        onCancel={() => setPendingRemoval(null)}
      />

      <ConfirmDialog
        open={pendingUpgrade !== null}
        title="Upgrade plugin"
        message={
          pendingUpgrade
            ? `"${pendingUpgrade.name}" has local edits that upgrading will overwrite. Continue?`
            : ""
        }
        confirmLabel="Upgrade"
        destructive
        onConfirm={confirmUpgrade}
        onCancel={() => setPendingUpgrade(null)}
      />
    </div>
  );
}

interface InstalledPluginRowProps {
  assistantId: string;
  item: PluginListItem;
  onSelect: () => void;
  onRemove: () => void;
  onUpgrade: (drift: PluginDrift | undefined) => void;
  isRemoving: boolean;
  isUpgrading: boolean;
}

/**
 * Wrapper for an installed row: a component (not a `.map()` callback) so the
 * `usePluginDrift` hook runs once per installed plugin. The resolved drift is
 * passed to `PluginListRow` (gating the Upgrade affordance) and handed back to
 * the tab on upgrade so it can decide whether to confirm-gate the overwrite.
 */
function InstalledPluginRow({
  assistantId,
  item,
  onSelect,
  onRemove,
  onUpgrade,
  isRemoving,
  isUpgrading,
}: InstalledPluginRowProps) {
  const driftQuery = usePluginDrift({ assistantId, name: item.name });
  const drift = driftQuery.data;

  return (
    <PluginListRow
      item={item}
      drift={drift}
      onSelect={onSelect}
      onRemove={onRemove}
      onUpgrade={() => onUpgrade(drift)}
      isRemoving={isRemoving}
      isUpgrading={isUpgrading}
    />
  );
}

function TipBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-body-small-default"
      style={{
        backgroundColor: "var(--surface-base)",
        color: "var(--content-secondary)",
      }}
    >
      <Sparkles
        className="h-4 w-4 shrink-0"
        style={{ color: "var(--primary-base)" }}
      />
      <p className="flex-1">
        Browse the catalog below to install plugins that extend your assistant.
      </p>
      <Button
        type="button"
        variant="ghost"
        size="compact"
        iconOnly={<X aria-hidden />}
        onClick={onDismiss}
        aria-label="Dismiss tip"
        tintColor="var(--content-tertiary)"
        expandOnMobile={false}
      />
    </div>
  );
}

function CatalogUnavailableNotice() {
  return (
    <div
      className="flex items-center gap-2 rounded-lg px-4 py-2.5 text-body-small-default"
      style={{
        backgroundColor: "var(--surface-base)",
        color: "var(--content-secondary)",
      }}
    >
      <CloudOff
        className="h-4 w-4 shrink-0"
        style={{ color: "var(--content-tertiary)" }}
        aria-hidden
      />
      <p className="flex-1">
        Catalog browsing is temporarily unavailable. Installed plugins are still
        listed below.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2
        className="h-6 w-6 animate-spin"
        style={{ color: "var(--content-tertiary)" }}
      />
    </div>
  );
}

function ErrorState() {
  return (
    <Card.Root>
      <Card.Body className="flex flex-col items-center justify-center py-16 text-center">
        <TriangleAlert
          className="mb-3 h-8 w-8"
          style={{ color: "var(--system-danger)" }}
          aria-hidden
        />
        <h3
          className="text-title-small"
          style={{ color: "var(--content-default)" }}
        >
          Failed to load plugins
        </h3>
        <p
          className="mt-1 max-w-sm text-body-medium-lighter"
          style={{ color: "var(--content-tertiary)" }}
        >
          Something went wrong. Try refreshing the page.
        </p>
      </Card.Body>
    </Card.Root>
  );
}

function EmptyState({ filter }: { filter: PluginFilter }) {
  const { title, subtitle, Icon } = getEmptyStateCopy(filter);
  return (
    <Card.Root>
      <Card.Body className="flex flex-col items-center justify-center py-16 text-center">
        <Icon
          className="mb-3 h-8 w-8"
          style={{ color: "var(--content-tertiary)" }}
          aria-hidden
        />
        <h3
          className="text-title-small"
          style={{ color: "var(--content-default)" }}
        >
          {title}
        </h3>
        <p
          className="mt-1 max-w-sm text-body-medium-lighter"
          style={{ color: "var(--content-tertiary)" }}
        >
          {subtitle}
        </p>
      </Card.Body>
    </Card.Root>
  );
}

function getEmptyStateCopy(filter: PluginFilter): {
  title: string;
  subtitle: string;
  Icon: typeof Puzzle;
} {
  switch (filter) {
    case "installed":
      return {
        title: "No Plugins Installed",
        subtitle: "Install a plugin from the catalog to extend your assistant.",
        Icon: Puzzle,
      };
    case "available":
      return {
        title: "No Plugins Available",
        subtitle: "Every catalog plugin is already installed.",
        Icon: CheckCircle,
      };
    default:
      return {
        title: "No Plugins Found",
        subtitle:
          "Browse the catalog to install plugins that extend your assistant.",
        Icon: Puzzle,
      };
  }
}
