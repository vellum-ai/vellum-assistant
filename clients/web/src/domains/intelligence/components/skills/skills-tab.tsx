import { useQuery } from "@tanstack/react-query";
import {
    CheckCircle,
    CloudOff,
    Globe,
    LayoutGrid,
    Package,
    Puzzle,
    Sparkles,
    Terminal,
    User,
    X,
    Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

import { CategorySidebar } from "@/domains/intelligence/components/skills/category-sidebar";
import { FilterBar } from "@/domains/intelligence/components/skills/skill-filters";
import { SkillRemovalDialog } from "@/domains/intelligence/components/skills/skill-removal-dialog";
import { SkillRow } from "@/domains/intelligence/components/skills/skill-row";
import { SkillsErrorState } from "@/domains/intelligence/components/skills/skills-error-state";
import { SkillsLoadingState } from "@/domains/intelligence/components/skills/skills-loading-state";
import { SkillsStateCard } from "@/domains/intelligence/components/skills/skills-state-card";
import {
  type SkillsSearchParamsUpdate,
  buildSkillsSearchParams,
  readSkillsUrlState,
} from "@/domains/intelligence/skills/skills-url-state";
import {
    type SkillFilter,
    type SkillInfo,
} from "@/domains/intelligence/skills/types";
import { useSkillActions } from "@/domains/intelligence/skills/use-skill-actions";
import { useSkillCategories } from "@/domains/intelligence/skills/use-skill-categories";
import { resolveFilterParams, sortSkills } from "@/domains/intelligence/skills/utils";
import { skillsGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { getLocalBool, setLocalBool } from "@/utils/local-settings";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library";

interface SkillsTabProps {
  assistantId: string;
}

const SEARCH_DEBOUNCE_MS = 300;
const TIP_STORAGE_KEY = "vellum:skills:tipDismissed";

export function SkillsTab({ assistantId }: SkillsTabProps) {
  const navigate = useNavigate();
  const location = useLocation();

  // Search/filter/category live in the URL (`?q=&filter=&category=`) so the
  // filtered view survives navigating to a skill detail page and back.
  const [searchParams, setSearchParams] = useSearchParams();
  const { q, filter, category } = useMemo(
    () => readSkillsUrlState(searchParams),
    [searchParams],
  );

  const updateUrlState = useCallback(
    (update: SkillsSearchParamsUpdate) => {
      // Replace rather than push so filter tweaks and typing don't pile up
      // history entries (same pattern as the usage tab's URL state).
      setSearchParams((prev) => buildSkillsSearchParams(prev, update), {
        replace: true,
      });
    },
    [setSearchParams],
  );

  // The search input stays in local state for responsive typing; the settled
  // (debounced) value is reflected into `?q=` below and drives the query.
  const [searchValue, setSearchValue] = useState(q);
  const debouncedSearch = useDebouncedValue(searchValue.trim(), SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    if (debouncedSearch !== q) {
      updateUrlState({ q: debouncedSearch });
    }
  }, [debouncedSearch, q, updateUrlState]);

  const handleFilterChange = useCallback(
    (next: SkillFilter) => updateUrlState({ filter: next }),
    [updateUrlState],
  );
  const handleCategoryChange = useCallback(
    (next: string | null) => updateUrlState({ category: next }),
    [updateUrlState],
  );

  const [tipDismissed, setTipDismissed] = useState(() =>
    getLocalBool(TIP_STORAGE_KEY, false),
  );

  const {
    handleInstall,
    handleRemove,
    isInstallingSkill,
    isRemovingSkill,
    skillPendingRemoval,
    confirmRemove,
    cancelRemove,
  } = useSkillActions(assistantId);

  const { data: categories = [] } = useSkillCategories(assistantId);

  const { origin, kind } = useMemo(() => resolveFilterParams(filter), [filter]);

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
    enabled: Boolean(assistantId),
  });

  const countsQuery = useQuery({
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
    enabled: Boolean(assistantId) && category !== null,
  });

  const handleDismissTip = useCallback(() => {
    setTipDismissed(true);
    setLocalBool(TIP_STORAGE_KEY, true);
  }, []);

  const allSkills = useMemo(
    () => skillsQuery.data?.skills ?? [],
    [skillsQuery.data?.skills],
  );

  const countsSource = category !== null ? countsQuery.data : skillsQuery.data;
  const { counts, totalCount } = useDerivedCounts(
    countsSource?.skills ?? allSkills,
    countsSource?.categoryCounts,
    countsSource?.totalCount,
  );

  const displayedSkills = useMemo(() => sortSkills(allSkills), [allSkills]);

  const isSearching = skillsQuery.isFetching && Boolean(debouncedSearch);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
      {!tipDismissed && <TipBanner onDismiss={handleDismissTip} />}

      <FilterBar
        search={searchValue}
        onSearchChange={setSearchValue}
        filter={filter}
        onFilterChange={handleFilterChange}
        isSearching={isSearching}
        categories={categories}
        category={category}
        onCategoryChange={handleCategoryChange}
        counts={counts}
        totalCount={totalCount}
        showCounts={!isSearching}
      />

      <div className="flex min-h-0 flex-1 gap-6">
        <aside className="hidden w-56 shrink-0 overflow-y-auto sm:block">
          <CategorySidebar
            selected={category}
            onSelect={handleCategoryChange}
            counts={counts}
            totalCount={totalCount}
            showCounts={!isSearching}
            categories={categories}
          />
        </aside>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {skillsQuery.isLoading ? (
            <SkillsLoadingState />
          ) : skillsQuery.isError ? (
            <SkillsErrorState />
          ) : displayedSkills.length === 0 ? (
            <EmptyState filter={filter} category={category} />
          ) : (
            <ul className="flex flex-col gap-2">
              {displayedSkills.map((skill) => (
                <li key={skill.id}>
                  <SkillRow
                    skill={skill}
                    onSelect={() =>
                      // Pass the current query string so the detail page's
                      // back button can restore this filtered view.
                      navigate(routes.skills.detail(skill.id), {
                        state: { listSearch: location.search },
                      })
                    }
                    onInstall={() => handleInstall(skill)}
                    onRemove={() => handleRemove(skill)}
                    isInstalling={isInstallingSkill(skill)}
                    isRemoving={isRemovingSkill(skill)}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <SkillRemovalDialog
        skill={skillPendingRemoval}
        onConfirm={confirmRemove}
        onCancel={cancelRemove}
      />
    </div>
  );
}

function useDerivedCounts(
  skills: SkillInfo[],
  serverCounts: Record<string, number> | undefined,
  serverTotal: number | undefined,
): { counts: Record<string, number>; totalCount: number } {
  return useMemo(() => {
    if (serverCounts && Object.keys(serverCounts).length > 0) {
      return {
        counts: serverCounts,
        totalCount: serverTotal ?? skills.length,
      };
    }
    const computed: Record<string, number> = {};
    for (const skill of skills) {
      const cat = skill.category ?? "system";
      computed[cat] = (computed[cat] ?? 0) + 1;
    }
    return {
      counts: computed,
      totalCount: serverTotal ?? skills.length,
    };
  }, [skills, serverCounts, serverTotal]);
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
        You can create a new custom skill by describing what you want in chat.
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

function EmptyState({
  filter,
  category,
}: {
  filter: SkillFilter;
  category: string | null;
}) {
  const { title, subtitle, Icon } = getEmptyStateCopy(filter, category);
  return <SkillsStateCard icon={Icon} title={title} subtitle={subtitle} />;
}

function getEmptyStateCopy(
  filter: SkillFilter,
  category: string | null,
): { title: string; subtitle: string; Icon: typeof Puzzle } {
  if (category) {
    return {
      title: "No skills in this category",
      subtitle: "Try selecting a different category or clearing the filter.",
      Icon: LayoutGrid,
    };
  }
  switch (filter) {
    case "installed":
      return {
        title: "No Skills Installed",
        subtitle:
          "Ask your assistant in chat to search for and install new skills.",
        Icon: Zap,
      };
    case "available":
      return {
        title: "No Skills Available",
        subtitle: "All available skills have been installed.",
        Icon: CheckCircle,
      };
    case "vellum":
      return {
        title: "No Vellum Skills",
        subtitle: "No bundled Vellum skills found.",
        Icon: Package,
      };
    case "clawhub":
      return {
        title: "No Clawhub Skills",
        subtitle: "No Clawhub skills found. Try searching the catalog.",
        Icon: Globe,
      };
    case "skillssh":
      return {
        title: "No skills.sh Skills",
        subtitle: "No skills.sh skills found. Try searching the catalog.",
        Icon: Terminal,
      };
    case "custom":
      return {
        title: "No Custom Skills",
        subtitle: "Create a custom skill by describing what you want in chat.",
        Icon: User,
      };
    default:
      return {
        title: "No Skills Available",
        subtitle: "Check your connection to the Vellum catalog.",
        Icon: CloudOff,
      };
  }
}
