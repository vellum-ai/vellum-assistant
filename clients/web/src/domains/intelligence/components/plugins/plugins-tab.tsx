import { useQueryClient } from "@tanstack/react-query";
import {
    CheckCircle,
    CloudOff,
    LayoutGrid,
    Loader2,
    Puzzle,
    Sparkles,
    TriangleAlert,
    X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { PluginDetail } from "@/domains/intelligence/components/plugins/plugin-detail";
import { PluginDetailMobile } from "@/domains/intelligence/components/plugins/plugin-detail-mobile";
import { FilterBar } from "@/domains/intelligence/components/plugins/plugin-filters";
import { PluginListRow } from "@/domains/intelligence/components/plugins/plugin-list-row";
// The category rail is the same component as Skills (shared taxonomy).
import { CategorySidebar } from "@/domains/intelligence/components/skills/category-sidebar";
import {
    PLUGIN_INSTALL_ERROR,
    PLUGIN_REMOVE_ERROR,
    PLUGIN_UPGRADE_ERROR,
    pluginRemoveConfirmMessage,
    pluginRiskyUpgradeConfirmLabel,
    pluginRiskyUpgradeConfirmMessage,
} from "@/domains/intelligence/plugins/constants";
import { invalidatePluginQueries } from "@/domains/intelligence/plugins/invalidate-plugin-queries";
import type {
    InstalledPlugin,
    PluginCatalogMatch,
    PluginFilter,
    PluginListItem,
} from "@/domains/intelligence/plugins/types";
import {
    SYSTEM_CATEGORY,
    usePluginsList,
} from "@/domains/intelligence/plugins/use-plugins-list";
import {
    filterByStatus,
    matchesQuery,
    shortSha,
} from "@/domains/intelligence/plugins/utils";
// Plugin categories reuse the SHARED Skills taxonomy (same hook + icon map).
import { useSkillCategories } from "@/domains/intelligence/skills/use-skill-categories";
import {
    hasLocalEdits,
    type PluginDrift,
    usePluginDrift,
} from "@/domains/intelligence/use-plugin-drift";
import {
    usePluginsByNameDeleteMutation,
    usePluginsByNameUpgradePostMutation,
    usePluginsInstallPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { getLocalBool, setLocalBool } from "@/utils/local-settings";
import { Button, Card, ConfirmDialog, toast } from "@vellumai/design-library";

interface PluginsTabProps {
  assistantId: string;
}

const TIP_STORAGE_KEY = "vellum:plugins:tipDismissed";

/**
 * Plugins tab list view, mirroring `SkillsTab`: a dismissible tip, a search +
 * status-filter bar, and a single installed-first list of `PluginListRow`s.
 * Install / remove / upgrade live here (the rows are presentational) so the
 * tab can gate destructive Remove and local-edit-overwriting Upgrade behind a
 * `ConfirmDialog`. Selecting a row opens the detail in-tab (like `SkillsTab`);
 * the open plugin is held in the `?plugin=<name>` URL param, so browser
 * back/forward and the Plugins tab link stay in sync with the detail.
 */
export function PluginsTab({ assistantId }: PluginsTabProps) {
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedPluginName = searchParams.get("plugin");

  const [searchValue, setSearchValue] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");
  const [category, setCategory] = useState<string | null>(null);
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

  // Category selection is per-assistant; clear it when the active assistant
  // changes so a stale slug isn't sent as `?category=` to the next assistant.
  useEffect(() => {
    setCategory(null);
  }, [assistantId]);

  const { data: categories = [] } = useSkillCategories(assistantId);

  const {
    items,
    isLoading,
    catalogLoading,
    isError,
    isFetching,
    catalogError,
    categorySupported,
    installedCategoryCounts,
    installedPlugins,
    installedTotal,
    catalogMatches,
    unfilteredInstalledNames,
  } = usePluginsList(assistantId, category);

  const { counts, totalCount } = useMergedPluginCounts(
    installedCategoryCounts,
    installedPlugins,
    installedTotal,
    catalogMatches,
    unfilteredInstalledNames,
    filter,
  );

  // Two-pane rail only when the daemon understands the category taxonomy AND
  // categories loaded — otherwise fall back to today's single-column layout.
  const categoryRailEnabled = categorySupported && categories.length > 0;

  const invalidate = useCallback(
    (name: string) => invalidatePluginQueries(queryClient, assistantId, name),
    [assistantId, queryClient],
  );

  const installMutation = usePluginsInstallPostMutation({
    onMutate: (variables) => setInstallingName(variables.body.name),
    onSuccess: (_data, variables) =>
      toast.success(`Installed ${variables.body.name}`),
    onError: () => toast.error(PLUGIN_INSTALL_ERROR),
    onSettled: (_data, _error, variables) => {
      setInstallingName(null);
      invalidate(variables.body.name);
    },
  });

  const removeMutation = usePluginsByNameDeleteMutation({
    onMutate: (variables) => setRemovingName(variables.path.name),
    onSuccess: (_data, variables) =>
      toast.success(`Removed ${variables.path.name}`),
    onError: () => toast.error(PLUGIN_REMOVE_ERROR),
    onSettled: (_data, _error, variables) => {
      setRemovingName(null);
      invalidate(variables.path.name);
    },
  });

  const upgradeMutation = usePluginsByNameUpgradePostMutation({
    onMutate: (variables) => setUpgradingName(variables.path.name),
    onSuccess: (result, variables) =>
      toast.success(
        result.outcome === "already-up-to-date"
          ? `${variables.path.name} is already up to date`
          : `Upgraded ${variables.path.name} to ${shortSha(result.toCommit)}`,
      ),
    onError: () => toast.error(PLUGIN_UPGRADE_ERROR),
    onSettled: (_data, _error, variables) => {
      setUpgradingName(null);
      invalidate(variables.path.name);
    },
  });

  // Selection lives in the `?plugin=` URL param so back/forward and the tab
  // link stay in sync with the open detail (opening pushes history; closing
  // replaces it so the in-detail Back acts as "close", not a forward step).
  const handleSelect = useCallback(
    (item: PluginListItem) =>
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("plugin", item.name);
        return next;
      }),
    [setSearchParams],
  );

  const handleCloseDetail = useCallback(
    () =>
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete("plugin");
          return next;
        },
        { replace: true },
      ),
    [setSearchParams],
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

  // Background-fetch state (focus refetch, post-install invalidation); drives
  // the search spinner only.
  const isSearching = isFetching && !isLoading;
  // Counts gate on the live term, not isSearching: search is client-side, so
  // it never trips the background-fetch signal — keying counts off that would
  // never hide them while filtering.
  const hasActiveSearch = searchValue.trim().length > 0;

  if (selectedPluginName) {
    // Seed the detail header icon from the already-loaded list row: catalog
    // rows are known-external (📦 immediately, no load-time flash). Installed
    // rows and unmatched deep-links are `undefined` (origin unknown), so the
    // header shows a glyph-less placeholder until the detail query resolves.
    const selectedExternalHint = items.find(
      (p) => p.name === selectedPluginName,
    )?.external;
    const detailProps = {
      assistantId,
      name: selectedPluginName,
      externalHint: selectedExternalHint,
      onBack: handleCloseDetail,
    };
    return isMobile ? (
      <PluginDetailMobile {...detailProps} />
    ) : (
      <PluginDetail {...detailProps} />
    );
  }

  const listColumn = (
    <div className="min-w-0 flex-1 overflow-y-auto">
      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState />
      ) : visibleItems.length === 0 ? (
        // Don't flash an "empty" state for available plugins while the
        // catalog is still loading (installed plugins already render above).
        catalogLoading && filter !== "installed" ? (
          <LoadingState />
        ) : (
          <EmptyState filter={filter} category={category} />
        )
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
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
      {!tipDismissed && <TipBanner onDismiss={handleDismissTip} />}

      <FilterBar
        search={searchValue}
        onSearchChange={setSearchValue}
        filter={filter}
        onFilterChange={setFilter}
        isSearching={isSearching}
        categories={categoryRailEnabled ? categories : []}
        category={category}
        onCategoryChange={setCategory}
        counts={counts}
        totalCount={totalCount}
        showCounts={!hasActiveSearch}
      />

      {catalogError && !isLoading && !isError ? (
        <CatalogUnavailableNotice />
      ) : null}

      {categoryRailEnabled ? (
        <div className="flex min-h-0 flex-1 gap-6">
          <aside className="hidden w-56 shrink-0 overflow-y-auto md:block">
            <CategorySidebar
              ariaLabel="Plugin categories"
              selected={category}
              onSelect={setCategory}
              counts={counts}
              totalCount={totalCount}
              showCounts={!hasActiveSearch}
              categories={categories}
            />
          </aside>
          {listColumn}
        </div>
      ) : (
        listColumn
      )}

      <ConfirmDialog
        open={pendingRemoval !== null}
        title="Remove plugin"
        message={
          pendingRemoval ? pluginRemoveConfirmMessage(pendingRemoval.name) : ""
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
            ? pluginRiskyUpgradeConfirmMessage(pendingUpgrade.name)
            : ""
        }
        confirmLabel={pluginRiskyUpgradeConfirmLabel}
        destructive
        onConfirm={confirmUpgrade}
        onCancel={() => setPendingUpgrade(null)}
      />
    </div>
  );
}

/**
 * Rail counts merge the two independent sources: the installed `categoryCounts`
 * (server) — or a client bucketing of installed plugins when the server omits
 * them — plus a client bucketing of the catalog. Catalog matches already in the
 * unfiltered installed set are skipped so an installed marketplace plugin counts
 * once (under installed), never twice. `totalCount` is the installed total + the
 * deduped catalog total, matching the deduped union of visible rows. Category
 * inputs are unfiltered, so badges stay stable while a category is selected.
 * The status `filter` is respected on the status axis (Skills derives counts
 * from both axes): `installed` counts only installed plugins, `available` only
 * the deduped catalog, so a badge never counts rows the status filter hides.
 * Mirrors skills' `useDerivedCounts`.
 */
function useMergedPluginCounts(
  installedCategoryCounts: Record<string, number> | undefined,
  installedPlugins: InstalledPlugin[],
  installedTotal: number | undefined,
  catalogMatches: PluginCatalogMatch[],
  unfilteredInstalledNames: Set<string>,
  filter: PluginFilter,
): { counts: Record<string, number>; totalCount: number } {
  return useMemo(() => {
    const counts: Record<string, number> = {};
    const includeInstalled = filter !== "available";
    const includeCatalog = filter !== "installed";

    if (includeInstalled) {
      if (
        installedCategoryCounts &&
        Object.keys(installedCategoryCounts).length > 0
      ) {
        Object.assign(counts, installedCategoryCounts);
      } else {
        for (const plugin of installedPlugins) {
          const cat = plugin.category ?? SYSTEM_CATEGORY;
          counts[cat] = (counts[cat] ?? 0) + 1;
        }
      }
    }
    let catalogTotal = 0;
    if (includeCatalog) {
      for (const match of catalogMatches) {
        // An installed marketplace plugin also appears in the catalog; counting
        // it here would double it against the installed counts, so dedup against
        // the unfiltered installed names — it already counts under installed.
        if (unfilteredInstalledNames.has(match.name)) continue;
        const cat = match.category ?? SYSTEM_CATEGORY;
        counts[cat] = (counts[cat] ?? 0) + 1;
        catalogTotal += 1;
      }
    }
    const installedTotalResolved = installedTotal ?? installedPlugins.length;
    const totalCount =
      (includeInstalled ? installedTotalResolved : 0) + catalogTotal;
    return { counts, totalCount };
  }, [
    installedCategoryCounts,
    installedPlugins,
    installedTotal,
    catalogMatches,
    unfilteredInstalledNames,
    filter,
  ]);
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

function EmptyState({
  filter,
  category,
}: {
  filter: PluginFilter;
  category: string | null;
}) {
  const { title, subtitle, Icon } = getEmptyStateCopy(filter, category);
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

function getEmptyStateCopy(
  filter: PluginFilter,
  category: string | null,
): {
  title: string;
  subtitle: string;
  Icon: typeof Puzzle;
} {
  if (category) {
    return {
      title: "No plugins in this category",
      subtitle: "Try selecting a different category or clearing the filter.",
      Icon: LayoutGrid,
    };
  }
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
