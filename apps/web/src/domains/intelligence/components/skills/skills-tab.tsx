import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  CheckCircle,
  ChevronDown,
  CloudOff,
  Globe,
  LayoutGrid,
  Loader2,
  Package,
  Puzzle,
  Search,
  Sparkles,
  Terminal,
  User,
  X,
  Zap,
} from "lucide-react";
import {
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { Button, Card, ConfirmDialog, Input, Popover } from "@vellum/design-library";
import {
  MobileSidebarDrawer,
  MobileSidebarTrigger,
} from "@/components/mobile-sidebar-drawer";
import { CategorySidebar } from "@/domains/intelligence/components/skills/category-sidebar";
import { SkillDetail } from "@/domains/intelligence/components/skills/skill-detail";
import { SkillRow } from "@/domains/intelligence/components/skills/skill-row";
import {
  fetchSkills,
  installSkill,
  uninstallSkill,
} from "@/domains/intelligence/skills/api";
import { inferCategory } from "@/domains/intelligence/skills/category";
import {
  isInstalledSkill,
  type SkillCategory,
  type SkillFilter,
  type SkillInfo,
} from "@/domains/intelligence/skills/types";

interface SkillsTabProps {
  assistantId: string;
  /**
   * Optional skill id to open in the detail view on first mount. Comes from
   * the `?skill=<id>` deep-link. Only seeds the initial state — internal
   * navigation thereafter is local state.
   */
  initialSkillId?: string;
}

interface FilterOption {
  value: SkillFilter;
  label: string;
  icon: typeof LayoutGrid;
}

const ALL_FILTER: FilterOption = { value: "all", label: "All", icon: LayoutGrid };

const STATUS_FILTERS: FilterOption[] = [
  ALL_FILTER,
  { value: "installed", label: "Installed", icon: CheckCircle },
  { value: "available", label: "Available", icon: ArrowDownToLine },
];

const ORIGIN_FILTERS: FilterOption[] = [
  { value: "vellum", label: "Vellum", icon: Package },
  { value: "clawhub", label: "Clawhub", icon: Globe },
  { value: "skillssh", label: "skills.sh", icon: Terminal },
  { value: "custom", label: "Custom", icon: User },
];

const FILTERS: FilterOption[] = [...STATUS_FILTERS, ...ORIGIN_FILTERS];

const SEARCH_DEBOUNCE_MS = 300;
const TIP_STORAGE_KEY = "vellum:skillsTabTipDismissed";

export function SkillsTab({ assistantId, initialSkillId }: SkillsTabProps) {
  const queryClient = useQueryClient();

  const [searchValue, setSearchValue] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filter, setFilter] = useState<SkillFilter>("all");
  const [category, setCategory] = useState<SkillCategory | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(initialSkillId ?? null);
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  const [removingSkillId, setRemovingSkillId] = useState<string | null>(null);
  const [skillPendingRemoval, setSkillPendingRemoval] = useState<SkillInfo | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tipDismissed, setTipDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(TIP_STORAGE_KEY) === "1";
  });

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(searchValue.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchValue]);

  const { origin, kind } = useMemo(() => resolveFilterParams(filter), [filter]);

  const skillsQuery = useQuery({
    queryKey: [
      "assistantSkills",
      assistantId,
      { origin, kind, q: debouncedSearch, category },
    ],
    queryFn: () =>
      fetchSkills(assistantId, {
        origin,
        kind,
        query: debouncedSearch || undefined,
        category: category ?? undefined,
      }),
    enabled: Boolean(assistantId),
  });

  const countsQuery = useQuery({
    queryKey: [
      "assistantSkills",
      assistantId,
      { origin, kind, q: debouncedSearch, category: null },
    ],
    queryFn: () =>
      fetchSkills(assistantId, {
        origin,
        kind,
        query: debouncedSearch || undefined,
      }),
    enabled: Boolean(assistantId) && category !== null,
  });

  const invalidateSkills = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ["assistantSkills", assistantId],
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
    mutationFn: (id: string) => uninstallSkill(assistantId, id),
    onMutate: (id) => setRemovingSkillId(id),
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
    uninstallMutation.mutate(skillPendingRemoval.id);
    setSkillPendingRemoval(null);
  }, [skillPendingRemoval, uninstallMutation]);

  const handleDismissTip = useCallback(() => {
    setTipDismissed(true);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(TIP_STORAGE_KEY, "1");
    }
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

function resolveFilterParams(filter: SkillFilter): {
  origin?: string;
  kind?: "installed" | "available";
} {
  switch (filter) {
    case "installed":
      return { kind: "installed" };
    case "available":
      return { kind: "available" };
    case "vellum":
    case "clawhub":
    case "skillssh":
    case "custom":
      return { origin: filter };
    default:
      return {};
  }
}

function sortSkills(skills: SkillInfo[]): SkillInfo[] {
  return [...skills].sort((a, b) => {
    const aInstalled = isInstalledSkill(a);
    const bInstalled = isInstalledSkill(b);
    if (aInstalled !== bInstalled) return aInstalled ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
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
      const cat = inferCategory(skill);
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

interface FilterBarProps {
  search: string;
  onSearchChange: Dispatch<SetStateAction<string>>;
  filter: SkillFilter;
  onFilterChange: (f: SkillFilter) => void;
  isSearching: boolean;
  onOpenDrawer: () => void;
}

function FilterBar({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  isSearching,
  onOpenDrawer,
}: FilterBarProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onSearchChange(e.target.value);
  };

  return (
    <div className="flex items-center gap-3">
      <MobileSidebarTrigger onClick={onOpenDrawer} />
      <Input
        type="search"
        value={search}
        onChange={handleChange}
        placeholder="Search Skills"
        aria-label="Search Skills"
        leftIcon={<Search className="h-4 w-4" aria-hidden />}
        rightIcon={
          isSearching ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : undefined
        }
        fullWidth
        wrapperClassName="flex-1"
      />

      <FilterDropdown value={filter} onChange={onFilterChange} />
    </div>
  );
}

function FilterDropdown({
  value,
  onChange,
}: {
  value: SkillFilter;
  onChange: (v: SkillFilter) => void;
}) {
  const [open, setOpen] = useState(false);

  const current = FILTERS.find((f) => f.value === value) ?? ALL_FILTER;
  const CurrentIcon = current.icon;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          className="inline-flex w-40 items-center justify-between gap-2 rounded-lg border bg-[var(--surface-active)] px-3 py-2 text-body-medium-lighter transition-colors hover:bg-[var(--surface-hover)]"
          style={{
            borderColor: "var(--border-base)",
            color: "var(--content-default)",
          }}
        >
          <span className="flex items-center gap-2 truncate">
            <CurrentIcon className="h-4 w-4" aria-hidden />
            <span className="truncate">{current.label}</span>
          </span>
          <ChevronDown
            className="h-4 w-4"
            style={{ color: "var(--content-tertiary)" }}
            aria-hidden
          />
        </button>
      </Popover.Trigger>
      <Popover.Content
        align="end"
        sideOffset={4}
        className="w-44 overflow-hidden p-0"
      >
        <ul role="listbox">
          <FilterGroup
            label="Status"
            options={STATUS_FILTERS}
            selected={value}
            onSelect={(v) => {
              onChange(v);
              setOpen(false);
            }}
          />
          <div
            className="border-t"
            style={{ borderColor: "var(--border-base)" }}
          />
          <FilterGroup
            label="Source"
            options={ORIGIN_FILTERS}
            selected={value}
            onSelect={(v) => {
              onChange(v);
              setOpen(false);
            }}
          />
        </ul>
      </Popover.Content>
    </Popover.Root>
  );
}

function FilterGroup({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: FilterOption[];
  selected: SkillFilter;
  onSelect: (v: SkillFilter) => void;
}) {
  return (
    <li>
      <div
        className="px-3 pb-1 pt-2 text-body-small-default uppercase tracking-wide"
        style={{ color: "var(--content-tertiary)" }}
      >
        {label}
      </div>
      <ul>
        {options.map((option) => {
          const Icon = option.icon;
          const isSelected = selected === option.value;
          return (
            <li key={option.value}>
              <button
                type="button"
                onClick={() => onSelect(option.value)}
                role="option"
                aria-selected={isSelected}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-body-medium-lighter transition-colors hover:bg-[var(--surface-hover)]"
                style={{
                  color: isSelected
                    ? "var(--primary-base)"
                    : "var(--content-default)",
                }}
              >
                <Icon className="h-4 w-4" aria-hidden />
                <span className="flex-1">{option.label}</span>
                {isSelected && <CheckCircle className="h-3.5 w-3.5" aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>
    </li>
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
