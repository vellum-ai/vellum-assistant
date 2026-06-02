import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle,
  CloudOff,
  Globe,
  LayoutGrid,
  Loader2,
  Package,
  Puzzle,
  Sparkles,
  Terminal,
  TriangleAlert,
  User,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { Button, Card, ConfirmDialog } from "@vellum/design-library";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { getLocalBool, setLocalBool } from "@/utils/local-settings";
import {
  MobileSidebarDrawer,
} from "@/components/mobile-sidebar-drawer";
import { CategorySidebar } from "@/domains/intelligence/components/skills/category-sidebar";
import { FilterBar } from "@/domains/intelligence/components/skills/skill-filters";
import { SkillDetail } from "@/domains/intelligence/components/skills/skill-detail";
import { SkillRow } from "@/domains/intelligence/components/skills/skill-row";
import {
  skillsGetOptions,
  skillsGetQueryKey,
  skillsByIdDeleteMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { type Options } from "@/generated/daemon/sdk.gen";
import type { SkillsGetData } from "@/generated/daemon/types.gen";
import { installSkill } from "@/domains/intelligence/skills/install";
import {
  type SkillCategory,
  type SkillFilter,
  type SkillInfo,
} from "@/domains/intelligence/skills/types";
import { resolveFilterParams, sortSkills } from "@/domains/intelligence/skills/utils";

interface SkillsTabProps {
  assistantId: string;
  /**
   * Optional skill id to open in the detail view on first mount. Comes from
   * the `?skill=<id>` deep-link. Only seeds the initial state — internal
   * navigation thereafter is local state.
   */
  initialSkillId?: string;
}

const SEARCH_DEBOUNCE_MS = 300;
const TIP_STORAGE_KEY = "vellum:skills:tipDismissed";

export function SkillsTab({ assistantId, initialSkillId }: SkillsTabProps) {
  const queryClient = useQueryClient();

  const [searchValue, setSearchValue] = useState("");
  const debouncedSearch = useDebouncedValue(searchValue.trim(), SEARCH_DEBOUNCE_MS);
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [category, setCategory] = useState<SkillCategory | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(initialSkillId ?? null);
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  const [removingSkillId, setRemovingSkillId] = useState<string | null>(null);
  const [skillPendingRemoval, setSkillPendingRemoval] = useState<SkillInfo | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tipDismissed, setTipDismissed] = useState(() =>
    getLocalBool(TIP_STORAGE_KEY, false),
  );

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

  const invalidateSkills = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: skillsGetQueryKey({
        path: { assistant_id: assistantId },
      } as Options<SkillsGetData>),
    });
  }, [assistantId, queryClient]);

  const installMutation = useMutation({
    mutationFn: (slug: string) => installSkill(assistantId, slug),
    onMutate: (slug) => setInstallingSkillId(slug),
    onSettled: () => {
      setInstallingSkillId(null);
      invalidateSkills();
    },
  });

  const uninstallMutation = useMutation({
    ...skillsByIdDeleteMutation(),
    onMutate: (variables) => setRemovingSkillId(variables.path.id),
    onSettled: () => {
      setRemovingSkillId(null);
      invalidateSkills();
    },
  });

  const handleInstall = useCallback(
    (skill: SkillInfo) => {
      installMutation.mutate(skill.slug ?? skill.id);
    },
    [installMutation],
  );

  const handleRemove = useCallback((skill: SkillInfo) => {
    setSkillPendingRemoval(skill);
  }, []);

  const confirmRemove = useCallback(() => {
    if (!skillPendingRemoval) {
      return;
    }
    uninstallMutation.mutate({
      path: { assistant_id: assistantId, id: skillPendingRemoval.id },
    });
    setSkillPendingRemoval(null);
  }, [assistantId, skillPendingRemoval, uninstallMutation]);

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

  const selectedSkill = useMemo(() => {
    if (!selectedSkillId) return null;
    return allSkills.find((s) => s.id === selectedSkillId) ?? null;
  }, [allSkills, selectedSkillId]);

  const removalDialog = (
    <ConfirmDialog
      open={skillPendingRemoval !== null}
      title="Remove skill"
      message={
        skillPendingRemoval
          ? `Remove "${skillPendingRemoval.name}" from this assistant?`
          : ""
      }
      confirmLabel="Remove"
      destructive
      onConfirm={confirmRemove}
      onCancel={() => setSkillPendingRemoval(null)}
    />
  );

  if (selectedSkill) {
    return (
      <>
        <SkillDetail
          assistantId={assistantId}
          skill={selectedSkill}
          onBack={() => setSelectedSkillId(null)}
          onInstall={() => handleInstall(selectedSkill)}
          onRemove={() => handleRemove(selectedSkill)}
          isInstalling={installingSkillId === (selectedSkill.slug ?? selectedSkill.id)}
          isRemoving={removingSkillId === selectedSkill.id}
        />
        {removalDialog}
      </>
    );
  }

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
        onOpenDrawer={() => setDrawerOpen(true)}
      />

      <div className="flex min-h-0 flex-1 gap-6">
        <aside className="hidden w-56 shrink-0 overflow-y-auto sm:block">
          <CategorySidebar
            selected={category}
            onSelect={setCategory}
            counts={counts}
            totalCount={totalCount}
            showCounts={!isSearching}
          />
        </aside>

        <MobileSidebarDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          title="Categories"
        >
          <CategorySidebar
            selected={category}
            onSelect={(c) => {
              setCategory(c);
              setDrawerOpen(false);
            }}
            counts={counts}
            totalCount={totalCount}
            showCounts={!isSearching}
          />
        </MobileSidebarDrawer>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {skillsQuery.isLoading ? (
            <LoadingState />
          ) : skillsQuery.isError ? (
            <ErrorState />
          ) : displayedSkills.length === 0 ? (
            <EmptyState filter={filter} category={category} />
          ) : (
            <ul className="flex flex-col gap-2">
              {displayedSkills.map((skill) => (
                <li key={skill.id}>
                  <SkillRow
                    skill={skill}
                    onSelect={() => setSelectedSkillId(skill.id)}
                    onInstall={() => handleInstall(skill)}
                    onRemove={() => handleRemove(skill)}
                    isInstalling={installingSkillId === (skill.slug ?? skill.id)}
                    isRemoving={removingSkillId === skill.id}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {removalDialog}
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
      const cat = skill.category ?? "knowledge";
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
      className="flex items-center gap-2 rounded-lg border px-4 py-2.5 text-body-medium-lighter"
      style={{
        borderColor: "color-mix(in oklab, var(--primary-base) 25%, transparent)",
        backgroundColor: "color-mix(in oklab, var(--primary-base) 8%, transparent)",
        color: "var(--content-default)",
      }}
    >
      <Sparkles
        className="h-4 w-4 shrink-0"
        style={{ color: "var(--primary-base)" }}
      />
      <p className="flex-1">
        <span className="text-body-medium-default">Tip:</span> You can create a new custom
        skill by describing what you want in chat.
      </p>
      <Button
        type="button"
        variant="ghost"
        size="compact"
        iconOnly={<X aria-hidden />}
        onClick={onDismiss}
        aria-label="Dismiss tip"
        tintColor="var(--content-tertiary)"
      />
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
          Failed to load skills
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
  filter: SkillFilter;
  category: SkillCategory | null;
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
  filter: SkillFilter,
  category: SkillCategory | null,
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
