import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
    CheckCircle,
    CloudOff,
    LayoutGrid,
    Loader2,
    Puzzle,
    Sparkles,
    TriangleAlert,
    X,
    Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

import { SkillRemovalDialog } from "@/components/skill-removal-dialog";
import { PluginDetail } from "@/domains/intelligence/components/plugins/plugin-detail";
import { PluginDetailMobile } from "@/domains/intelligence/components/plugins/plugin-detail-mobile";
import { PluginListRow } from "@/domains/intelligence/components/plugins/plugin-list-row";
import { CategorySidebar } from "@/domains/intelligence/components/skills/category-sidebar";
import { SkillRow } from "@/domains/intelligence/components/skills/skill-row";
import { SkillsStateCard } from "@/domains/intelligence/components/skills/skills-state-card";
import { FilterBar } from "@/domains/intelligence/components/superpowers/superpowers-filters";
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
import {
    isInstalledSkill,
    type SkillInfo,
} from "@/domains/intelligence/skills/types";
import { useSkillActions } from "@/domains/intelligence/skills/use-skill-actions";
import { useSkillCategories } from "@/domains/intelligence/skills/use-skill-categories";
import {
  type SuperpowersSearchParamsUpdate,
  buildSuperpowersSearchParams,
  readSuperpowersUrlState,
} from "@/domains/intelligence/superpowers/superpowers-url-state";
import type { SuperpowerFilter } from "@/domains/intelligence/superpowers/types";
import {
    filterShowsPlugins,
    filterShowsSkills,
    pluginFilterFor,
    skillParamsForFilter,
} from "@/domains/intelligence/superpowers/utils";
import {
    hasLocalEdits,
    type PluginDrift,
    usePluginDrift,
} from "@/domains/intelligence/use-plugin-drift";
import {
    skillsGetOptions,
    usePluginsByNameDeleteMutation,
    usePluginsByNameUpgradePostMutation,
    usePluginsInstallPostMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useSupportsPluginsSurface } from "@/lib/backwards-compat/plugins-surface";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { getLocalBool, setLocalBool } from "@/utils/local-settings";
import { routes } from "@/utils/routes";
import { Button, Card, ConfirmDialog, toast } from "@vellumai/design-library";

interface SuperpowersTabProps {
  assistantId: string;
}

const SEARCH_DEBOUNCE_MS = 300;
const TIP_STORAGE_KEY = "vellum:superpowers:tipDismissed";

/** One merged, sortable row — a skill or a plugin. */
type SuperpowerRow =
  | { type: "skill"; key: string; name: string; installed: boolean; skill: SkillInfo }
  | { type: "plugin"; key: string; name: string; installed: boolean; item: PluginListItem };

/** Installed first, then alphabetical by name — skills and plugins interleaved. */
function sortRows(rows: SuperpowerRow[]): SuperpowerRow[] {
  return [...rows].sort((a, b) => {
    if (a.installed !== b.installed) {return a.installed ? -1 : 1;}
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/**
 * The My Superpowers list: skills and plugins merged into one installed-first
 * list behind a shared search box, filter control (status / type / source),
 * and category rail (the two surfaces share the category taxonomy).
 *
 * Skill rows keep their per-skill detail route (`/assistant/skills/:skillId`);
 * plugin rows open their detail in-tab via the `?plugin=<name>` URL param so
 * browser back/forward and deep links stay in sync. Plugin rows carry a
 * "Plugin" badge (see `PluginListRow`) so the two kinds read apart at a glance.
 *
 * Search/filter/category live in the URL (`?q=&filter=&category=`) so the
 * filtered view survives navigating into a detail and back.
 *
 * On assistants without the plugin surface (backwards-compat version gate)
 * the plugin queries stay disabled and the list is skills-only.
 */
export function SuperpowersTab({ assistantId }: SuperpowersTabProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const version = useAssistantIdentityStore.use.version();
  const pluginsSupported = useSupportsPluginsSurface();

  const [searchParams, setSearchParams] = useSearchParams();
  const { q, filter, category } = useMemo(
    () => readSuperpowersUrlState(searchParams),
    [searchParams],
  );
  const selectedPluginName = searchParams.get("plugin");

  const updateUrlState = useCallback(
    (update: SuperpowersSearchParamsUpdate) => {
      // Replace rather than push so filter tweaks and typing don't pile up
      // history entries (same pattern as the usage tab's URL state).
      setSearchParams((prev) => buildSuperpowersSearchParams(prev, update), {
        replace: true,
      });
    },
    [setSearchParams],
  );

  // `?success=true` is set when another surface (e.g. the marketing plugin
  // page's "Install in your assistant" button) installs a plugin and then
  // deep-links here. Confirm it with a toast once, then strip the flag so a
  // refresh or back/forward doesn't re-fire it. The `?plugin=` param stays, so
  // the just-installed plugin's detail opens as usual.
  const successFlag = searchParams.get("success");
  const successToastedRef = useRef(false);
  useEffect(() => {
    if (successFlag !== "true" || successToastedRef.current) {
      return;
    }
    successToastedRef.current = true;
    if (selectedPluginName) {
      toast.success(`Installed ${selectedPluginName}`);
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("success");
        return next;
      },
      { replace: true },
    );
  }, [successFlag, selectedPluginName, setSearchParams]);

  // The search input stays in local state for responsive typing; the settled
  // (debounced) value is reflected into `?q=` below and drives the query.
  const [searchValue, setSearchValue] = useState(q);
  const debouncedSearch = useDebouncedValue(searchValue.trim(), SEARCH_DEBOUNCE_MS);
  // Last `q` this component reconciled with the URL — distinguishes our own
  // writes (echoed back through `useSearchParams`) from external changes
  // (re-clicking the nav link, back/forward, in-app filtered links).
  const lastSyncedQ = useRef(q);
  useEffect(() => {
    if (q !== lastSyncedQ.current) {
      // `?q=` changed externally without a remount — adopt it instead of
      // debounce-writing the stale local value back over it.
      lastSyncedQ.current = q;
      if (q !== searchValue.trim()) {
        setSearchValue(q);
        return;
      }
    }
    // Only write once the debounce has settled to the current input; while it
    // lags (mid-typing or right after adopting an external change) a write
    // would resurrect an outdated value.
    if (debouncedSearch !== q && debouncedSearch === searchValue.trim()) {
      lastSyncedQ.current = debouncedSearch;
      updateUrlState({ q: debouncedSearch });
    }
  }, [debouncedSearch, q, searchValue, updateUrlState]);

  const handleFilterChange = useCallback(
    (next: SuperpowerFilter) => updateUrlState({ filter: next }),
    [updateUrlState],
  );
  const handleCategoryChange = useCallback(
    (next: string | null) => updateUrlState({ category: next }),
    [updateUrlState],
  );

  const [tipDismissed, setTipDismissed] = useState(() =>
    getLocalBool(TIP_STORAGE_KEY, false),
  );
  const handleDismissTip = useCallback(() => {
    setTipDismissed(true);
    setLocalBool(TIP_STORAGE_KEY, true);
  }, []);

  // A `plugins` filter carried into an assistant without the plugin surface
  // would leave the list unreachable-empty — coerce to All. The raw URL value
  // is preserved, so the filter revives if the surface appears.
  const effectiveFilter: SuperpowerFilter =
    !pluginsSupported && filter === "plugins" ? "all" : filter;

  const showSkills = filterShowsSkills(effectiveFilter);
  const pluginsInScope = pluginsSupported && filterShowsPlugins(effectiveFilter);
  const pluginStatusFilter: PluginFilter = pluginFilterFor(effectiveFilter);

  // ---- Skills data --------------------------------------------------------

  const {
    handleInstall: handleSkillInstall,
    handleRemove: handleSkillRemove,
    isInstallingSkill,
    isRemovingSkill,
    skillPendingRemoval,
    confirmRemove: confirmSkillRemove,
    cancelRemove: cancelSkillRemove,
  } = useSkillActions(assistantId);

  const { data: categories = [] } = useSkillCategories(assistantId);

  const { origin, kind } = useMemo(
    () => skillParamsForFilter(effectiveFilter),
    [effectiveFilter],
  );

  const skillsQuery = useQuery({
    ...skillsGetOptions({
      path: { assistant_id: assistantId },
      query: {
        include: "catalog",
        origin,
        kind,
        q: debouncedSearch || undefined,
        category: category ?? undefined,
      },
    }),
    select: (data): { skills: SkillInfo[]; categoryCounts?: Record<string, number>; totalCount?: number } => ({
      skills: data.skills,
      categoryCounts: data.categoryCounts,
      totalCount: data.totalCount,
    }),
    enabled: Boolean(assistantId) && showSkills,
  });

  const skillCountsQuery = useQuery({
    ...skillsGetOptions({
      path: { assistant_id: assistantId },
      query: {
        include: "catalog",
        origin,
        kind,
        q: debouncedSearch || undefined,
      },
    }),
    select: (data): { skills: SkillInfo[]; categoryCounts?: Record<string, number>; totalCount?: number } => ({
      skills: data.skills,
      categoryCounts: data.categoryCounts,
      totalCount: data.totalCount,
    }),
    enabled: Boolean(assistantId) && showSkills && category !== null,
  });

  // ---- Plugins data -------------------------------------------------------

  const {
    items: pluginItems,
    isLoading: pluginsLoading,
    catalogLoading,
    isError: pluginsError,
    isFetching: pluginsFetching,
    catalogError,
    categorySupported: pluginCategorySupported,
    installedCategoryCounts,
    installedPlugins,
    installedTotal,
    catalogMatches,
    unfilteredInstalledNames,
  } = usePluginsList(assistantId, category, pluginsSupported);

  // Older daemons ignore the installed read's `?category=` param, so under a
  // selected category they'd surface every plugin in every bucket — hide
  // plugins there instead.
  const pluginsVisible =
    pluginsInScope && (category === null || pluginCategorySupported);

  const invalidate = useCallback(
    (name: string) => invalidatePluginQueries(queryClient, assistantId, name),
    [assistantId, queryClient],
  );

  const [installingName, setInstallingName] = useState<string | null>(null);
  const [removingName, setRemovingName] = useState<string | null>(null);
  const [upgradingName, setUpgradingName] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PluginListItem | null>(
    null,
  );
  const [pendingUpgrade, setPendingUpgrade] = useState<PluginListItem | null>(
    null,
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

  // Plugin selection lives in the `?plugin=` URL param so back/forward and
  // deep links stay in sync with the open detail (opening pushes history;
  // closing replaces it so the in-detail Back acts as "close").
  const handlePluginSelect = useCallback(
    (item: PluginListItem) =>
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("plugin", item.name);
        return next;
      }),
    [setSearchParams],
  );

  const handleClosePluginDetail = useCallback(
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

  const handlePluginInstall = useCallback(
    (item: PluginListItem) => {
      installMutation.mutate({
        path: { assistant_id: assistantId },
        body: { name: item.name },
      });
    },
    [assistantId, installMutation],
  );

  const confirmPluginRemove = useCallback(() => {
    if (!pendingRemoval) {return;}
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

  const confirmPluginUpgrade = useCallback(() => {
    if (!pendingUpgrade) {return;}
    runUpgrade(pendingUpgrade.name);
    setPendingUpgrade(null);
  }, [pendingUpgrade, runUpgrade]);

  // Upgrading directly overwrites the installed copy. When that copy has local
  // edits, gate behind a confirm dialog so the overwrite is intentional; the
  // drift comes from the per-row inspect, so the row hands it back up.
  const handlePluginUpgrade = useCallback(
    (item: PluginListItem, drift: PluginDrift | undefined) => {
      if (hasLocalEdits(drift)) {
        setPendingUpgrade(item);
        return;
      }
      runUpgrade(item.name);
    },
    [runUpgrade],
  );

  // ---- Merged rows & counts ----------------------------------------------

  const skills = useMemo(
    () => (showSkills ? (skillsQuery.data?.skills ?? []) : []),
    [showSkills, skillsQuery.data?.skills],
  );

  const visiblePluginItems = useMemo(
    () =>
      pluginsVisible
        ? filterByStatus(pluginItems, pluginStatusFilter).filter((item) =>
            matchesQuery(item, debouncedSearch),
          )
        : [],
    [pluginsVisible, pluginItems, pluginStatusFilter, debouncedSearch],
  );

  const rows = useMemo(
    () =>
      sortRows([
        ...skills.map(
          (skill): SuperpowerRow => ({
            type: "skill",
            key: `skill:${skill.id}`,
            name: skill.name,
            installed: isInstalledSkill(skill),
            skill,
          }),
        ),
        ...visiblePluginItems.map(
          (item): SuperpowerRow => ({
            type: "plugin",
            key: `plugin:${item.name}`,
            name: item.name,
            installed: item.status === "installed",
            item,
          }),
        ),
      ]),
    [skills, visiblePluginItems],
  );

  const skillCountsSource =
    category !== null ? skillCountsQuery.data : skillsQuery.data;
  const skillCounts = useDerivedSkillCounts(
    showSkills,
    skillCountsSource?.skills ?? skills,
    skillCountsSource?.categoryCounts,
    skillCountsSource?.totalCount,
  );

  // Plugin rail counts need the category taxonomy on the daemon; without it
  // the buckets are unknown, so plugins contribute nothing (matching the rows,
  // which hide under a selected category on those daemons).
  const pluginCounts = useMergedPluginCounts(
    pluginsInScope && pluginCategorySupported,
    installedCategoryCounts,
    installedPlugins,
    installedTotal,
    catalogMatches,
    unfilteredInstalledNames,
    pluginStatusFilter,
  );

  const { counts, totalCount } = useMemo(() => {
    const merged: Record<string, number> = { ...skillCounts.counts };
    for (const [cat, n] of Object.entries(pluginCounts.counts)) {
      merged[cat] = (merged[cat] ?? 0) + n;
    }
    return {
      counts: merged,
      totalCount: skillCounts.totalCount + pluginCounts.totalCount,
    };
  }, [skillCounts, pluginCounts]);

  // ---- Loading / error rollup --------------------------------------------

  const skillsLoading = showSkills && skillsQuery.isLoading;
  const skillsFailed = showSkills && skillsQuery.isError;
  const pluginsListLoading = pluginsVisible && pluginsLoading;
  const pluginsFailed = pluginsVisible && pluginsError;
  // Fatal only when every visible primary source failed; a one-sided failure
  // degrades to a notice above the surviving rows.
  const allFailed =
    (skillsFailed || !showSkills) &&
    (pluginsFailed || !pluginsVisible) &&
    (skillsFailed || pluginsFailed);

  const isLoading = skillsLoading || pluginsListLoading;
  const isSearching =
    Boolean(debouncedSearch) &&
    ((showSkills && skillsQuery.isFetching) ||
      (pluginsVisible && pluginsFetching && !pluginsLoading));
  // Counts gate on the live term: plugin counts are client-side and don't
  // track the search, so showing them mid-search would mislead.
  const hasActiveSearch = searchValue.trim().length > 0;

  // ---- Plugin detail (in-tab) --------------------------------------------

  if (selectedPluginName && !pluginsSupported && version === null) {
    // A plugin deep-link before the assistant version hydrates: wait rather
    // than flashing the list and then swapping to the detail.
    return null;
  }

  if (selectedPluginName && pluginsSupported) {
    // Seed the detail header icon + auto-include toggle from the already-loaded
    // list row: catalog rows are known-external (📦 immediately, no load-time
    // flash). Installed rows and unmatched deep-links are `undefined` (origin
    // unknown), so the header shows a glyph-less placeholder until the detail
    // query resolves. `enabled` is likewise sourced from the row — the detail
    // GET carries no enablement — and is `undefined` for available/deep-link
    // rows, which hides the toggle.
    const selectedRow = pluginItems.find((p) => p.name === selectedPluginName);
    const detailProps = {
      assistantId,
      name: selectedPluginName,
      externalHint: selectedRow?.external,
      enabled: selectedRow?.enabled,
      onBack: handleClosePluginDetail,
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
      ) : allFailed ? (
        <ErrorState />
      ) : rows.length === 0 ? (
        // Don't flash an "empty" state for available plugins while the
        // catalog is still loading (installed rows already render above).
        pluginsVisible && catalogLoading && pluginStatusFilter !== "installed" ? (
          <LoadingState />
        ) : (
          <EmptyState filter={effectiveFilter} category={category} />
        )
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.key}>
              {row.type === "skill" ? (
                <SkillRow
                  skill={row.skill}
                  onSelect={() =>
                    // Pass the current query string so the detail page's
                    // back button can restore this filtered view.
                    navigate(routes.skills.detail(row.skill.id), {
                      state: { listSearch: location.search },
                    })
                  }
                  onInstall={() => handleSkillInstall(row.skill)}
                  onRemove={() => handleSkillRemove(row.skill)}
                  isInstalling={isInstallingSkill(row.skill)}
                  isRemoving={isRemovingSkill(row.skill)}
                />
              ) : row.installed ? (
                <InstalledPluginRow
                  assistantId={assistantId}
                  item={row.item}
                  onSelect={() => handlePluginSelect(row.item)}
                  onRemove={() => setPendingRemoval(row.item)}
                  onUpgrade={(drift) => handlePluginUpgrade(row.item, drift)}
                  isRemoving={removingName === row.item.name}
                  isUpgrading={upgradingName === row.item.name}
                />
              ) : (
                <PluginListRow
                  assistantId={assistantId}
                  item={row.item}
                  onSelect={() => handlePluginSelect(row.item)}
                  onInstall={() => handlePluginInstall(row.item)}
                  isInstalling={installingName === row.item.name}
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
        filter={effectiveFilter}
        onFilterChange={handleFilterChange}
        isSearching={isSearching}
        categories={categories}
        category={category}
        onCategoryChange={handleCategoryChange}
        counts={counts}
        totalCount={totalCount}
        showCounts={!hasActiveSearch}
        pluginsSupported={pluginsSupported}
      />

      {!isLoading && !allFailed && skillsFailed ? (
        <DegradedNotice text="Skills are temporarily unavailable. Plugins are still listed below." />
      ) : null}
      {!isLoading && !allFailed && pluginsFailed ? (
        <DegradedNotice text="Plugins are temporarily unavailable. Skills are still listed below." />
      ) : null}
      {pluginsVisible && catalogError && !pluginsListLoading && !pluginsFailed ? (
        <DegradedNotice text="Plugin catalog browsing is temporarily unavailable. Installed plugins are still listed below." />
      ) : null}

      <div className="flex min-h-0 flex-1 gap-6">
        <aside className="hidden w-56 shrink-0 overflow-y-auto sm:block">
          <CategorySidebar
            ariaLabel="Superpower categories"
            selected={category}
            onSelect={handleCategoryChange}
            counts={counts}
            totalCount={totalCount}
            showCounts={!hasActiveSearch}
            categories={categories}
          />
        </aside>

        {listColumn}
      </div>

      <SkillRemovalDialog
        skillName={skillPendingRemoval?.name ?? null}
        onConfirm={confirmSkillRemove}
        onCancel={cancelSkillRemove}
      />

      <ConfirmDialog
        open={pendingRemoval !== null}
        title="Remove plugin"
        message={
          pendingRemoval ? pluginRemoveConfirmMessage(pendingRemoval.name) : ""
        }
        confirmLabel="Remove"
        destructive
        onConfirm={confirmPluginRemove}
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
        onConfirm={confirmPluginUpgrade}
        onCancel={() => setPendingUpgrade(null)}
      />
    </div>
  );
}

/**
 * Skill-side rail counts: server `categoryCounts` when present, otherwise a
 * client bucketing of the loaded skills. Zeroed while the filter hides skills.
 */
function useDerivedSkillCounts(
  showSkills: boolean,
  skills: SkillInfo[],
  serverCounts: Record<string, number> | undefined,
  serverTotal: number | undefined,
): { counts: Record<string, number>; totalCount: number } {
  return useMemo(() => {
    if (!showSkills) {
      return { counts: {}, totalCount: 0 };
    }
    if (serverCounts && Object.keys(serverCounts).length > 0) {
      return {
        counts: serverCounts,
        totalCount: serverTotal ?? skills.length,
      };
    }
    const computed: Record<string, number> = {};
    for (const skill of skills) {
      const cat = skill.category ?? SYSTEM_CATEGORY;
      computed[cat] = (computed[cat] ?? 0) + 1;
    }
    return {
      counts: computed,
      totalCount: serverTotal ?? skills.length,
    };
  }, [showSkills, skills, serverCounts, serverTotal]);
}

/**
 * Plugin-side rail counts, merged from the installed `categoryCounts` (server,
 * or a client bucketing when the server omits them) and a client bucketing of
 * the catalog. Catalog matches already installed are skipped so an installed
 * marketplace plugin counts once, not twice; `totalCount` is the deduped union
 * total. Inputs are unfiltered (badges stay stable while a category is
 * selected), but the status `filter` is honored so a badge never counts rows
 * that filter hides. Zeroed while plugins are out of scope.
 */
function useMergedPluginCounts(
  includePlugins: boolean,
  installedCategoryCounts: Record<string, number> | undefined,
  installedPlugins: InstalledPlugin[],
  installedTotal: number | undefined,
  catalogMatches: PluginCatalogMatch[],
  unfilteredInstalledNames: Set<string>,
  filter: PluginFilter,
): { counts: Record<string, number>; totalCount: number } {
  return useMemo(() => {
    if (!includePlugins) {
      return { counts: {}, totalCount: 0 };
    }
    const counts: Record<string, number> = {};
    const includeInstalled = filter !== "available";
    const includeCatalog = filter === "all" || filter === "available";

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
        if (unfilteredInstalledNames.has(match.name)) {continue;}
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
    includePlugins,
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
 * Wrapper for an installed plugin row: a component (not a `.map()` callback)
 * so the `usePluginDrift` hook runs once per installed plugin. The resolved
 * drift is passed to `PluginListRow` (gating the Upgrade affordance) and
 * handed back to the tab on upgrade so it can decide whether to confirm-gate
 * the overwrite.
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
      assistantId={assistantId}
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
        Create a new custom skill by describing what you want in chat, or
        install plugins to extend your assistant.
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

function DegradedNotice({ text }: { text: string }) {
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
      <p className="flex-1">{text}</p>
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
          Failed to load superpowers
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
  filter: SuperpowerFilter;
  category: string | null;
}) {
  const { title, subtitle, Icon } = getEmptyStateCopy(filter, category);
  return <SkillsStateCard icon={Icon} title={title} subtitle={subtitle} />;
}

function getEmptyStateCopy(
  filter: SuperpowerFilter,
  category: string | null,
): { title: string; subtitle: string; Icon: typeof Puzzle } {
  if (category) {
    return {
      title: "Nothing in this category",
      subtitle: "Try selecting a different category or clearing the filter.",
      Icon: LayoutGrid,
    };
  }
  switch (filter) {
    case "installed":
      return {
        title: "No Superpowers Installed",
        subtitle:
          "Ask your assistant in chat to search for and install new skills and plugins.",
        Icon: Zap,
      };
    case "available":
      return {
        title: "Nothing Left to Install",
        subtitle: "All available skills and plugins are installed.",
        Icon: CheckCircle,
      };
    case "skills":
      return {
        title: "No Skills Found",
        subtitle:
          "Ask your assistant in chat to search for and install new skills.",
        Icon: Zap,
      };
    case "plugins":
      return {
        title: "No Plugins Found",
        subtitle:
          "Browse the catalog to install plugins that extend your assistant.",
        Icon: Puzzle,
      };
    case "vellum":
      return {
        title: "No Vellum Skills",
        subtitle: "No bundled Vellum skills found.",
        Icon: Zap,
      };
    case "clawhub":
      return {
        title: "No Clawhub Skills",
        subtitle: "No Clawhub skills found. Try searching the catalog.",
        Icon: Zap,
      };
    case "skillssh":
      return {
        title: "No skills.sh Skills",
        subtitle: "No skills.sh skills found. Try searching the catalog.",
        Icon: Zap,
      };
    case "custom":
      return {
        title: "No Custom Skills",
        subtitle: "Create a custom skill by describing what you want in chat.",
        Icon: Zap,
      };
    case "assistant-memory":
      return {
        title: "No Skills From Memory",
        subtitle:
          "Skills your assistant authors from past conversations will appear here.",
        Icon: Zap,
      };
    default:
      return {
        title: "No Superpowers Available",
        subtitle: "Check your connection to the Vellum catalog.",
        Icon: CloudOff,
      };
  }
}
