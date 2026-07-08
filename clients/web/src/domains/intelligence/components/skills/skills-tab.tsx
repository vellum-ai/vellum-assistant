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
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { CategorySidebar } from "@/domains/intelligence/components/skills/category-sidebar";
import { FilterBar } from "@/domains/intelligence/components/skills/skill-filters";
import { SkillRemovalDialog } from "@/domains/intelligence/components/skills/skill-removal-dialog";
import { SkillRow } from "@/domains/intelligence/components/skills/skill-row";
import { SkillsErrorState } from "@/domains/intelligence/components/skills/skills-error-state";
import { SkillsLoadingState } from "@/domains/intelligence/components/skills/skills-loading-state";
import { SkillsStateCard } from "@/domains/intelligence/components/skills/skills-state-card";
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

  const [searchValue, setSearchValue] = useState("");
  const debouncedSearch = useDebouncedValue(searchValue.trim(), SEARCH_DEBOUNCE_MS);
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [category, setCategory] = useState<string | null>(null);
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
        onFilterChange={setFilter}
        isSearching={isSearching}
        categories={categories}
        category={category}
        onCategoryChange={setCategory}
        counts={counts}
        totalCount={totalCount}
        showCounts={!isSearching}
      />

      <div className="flex min-h-0 flex-1 gap-6">
        <aside className="hidden w-56 shrink-0 overflow-y-auto sm:block">
          <CategorySidebar
            selected={category}
            onSelect={setCategory}
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
                    onSelect={() => navigate(routes.skills.detail(skill.id))}
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
