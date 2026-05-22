import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  CheckCircle,
  ChevronDown,
  CloudOff,
  LayoutGrid,
  Loader2,
  Puzzle,
  Search,
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

import { Card, ConfirmDialog, Input, Popover } from "@vellum/design-library";
import { PluginRow } from "@/domains/intelligence/components/plugins/plugin-row.js";
import {
  fetchPlugins,
  installPlugin,
  uninstallPlugin,
} from "@/domains/intelligence/plugins/api.js";
import {
  isInstalledPlugin,
  type PluginFilter,
  type PluginInfo,
} from "@/domains/intelligence/plugins/types.js";

interface PluginsTabProps {
  assistantId: string;
}

interface FilterOption {
  value: PluginFilter;
  label: string;
  icon: typeof LayoutGrid;
}

const ALL_FILTER: FilterOption = { value: "all", label: "All", icon: LayoutGrid };

const FILTERS: FilterOption[] = [
  ALL_FILTER,
  { value: "installed", label: "Installed", icon: CheckCircle },
  { value: "available", label: "Available", icon: ArrowDownToLine },
];

const SEARCH_DEBOUNCE_MS = 300;

export function PluginsTab({ assistantId }: PluginsTabProps) {
  const queryClient = useQueryClient();

  const [searchValue, setSearchValue] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filter, setFilter] = useState<PluginFilter>("all");
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [pluginPendingRemoval, setPluginPendingRemoval] =
    useState<PluginInfo | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(searchValue.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchValue]);

  const kind = useMemo(() => resolveKind(filter), [filter]);

  const pluginsQuery = useQuery({
    queryKey: ["assistantPlugins", assistantId, { kind, q: debouncedSearch }],
    queryFn: () =>
      fetchPlugins(assistantId, {
        kind,
        query: debouncedSearch || undefined,
      }),
    enabled: Boolean(assistantId),
  });

  const invalidatePlugins = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ["assistantPlugins", assistantId],
    });
  }, [assistantId, queryClient]);

  const installMutation = useMutation({
    mutationFn: (name: string) => installPlugin(assistantId, { name }),
    onMutate: (name) => setInstallingId(name),
    onSettled: () => {
      setInstallingId(null);
      invalidatePlugins();
    },
  });

  const uninstallMutation = useMutation({
    mutationFn: (name: string) => uninstallPlugin(assistantId, name),
    onMutate: (name) => setRemovingId(name),
    onSettled: () => {
      setRemovingId(null);
      invalidatePlugins();
    },
  });

  const handleInstall = useCallback(
    (plugin: PluginInfo) => {
      installMutation.mutate(plugin.name);
    },
    [installMutation],
  );

  const handleRemove = useCallback((plugin: PluginInfo) => {
    setPluginPendingRemoval(plugin);
  }, []);

  const confirmRemove = useCallback(() => {
    if (!pluginPendingRemoval) return;
    uninstallMutation.mutate(pluginPendingRemoval.name);
    setPluginPendingRemoval(null);
  }, [pluginPendingRemoval, uninstallMutation]);

  const allPlugins = useMemo(
    () => pluginsQuery.data?.plugins ?? [],
    [pluginsQuery.data?.plugins],
  );

  const displayedPlugins = useMemo(
    () => sortPlugins(allPlugins),
    [allPlugins],
  );

  const isSearching = pluginsQuery.isFetching && Boolean(debouncedSearch);

  const removalDialog = (
    <ConfirmDialog
      open={pluginPendingRemoval !== null}
      title="Remove plugin"
      message={
        pluginPendingRemoval
          ? `Remove "${pluginPendingRemoval.name}" from this assistant?`
          : ""
      }
      confirmLabel="Remove"
      destructive
      onConfirm={confirmRemove}
      onCancel={() => setPluginPendingRemoval(null)}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
      <FilterBar
        search={searchValue}
        onSearchChange={setSearchValue}
        filter={filter}
        onFilterChange={setFilter}
        isSearching={isSearching}
      />

      <div className="min-w-0 flex-1 overflow-y-auto">
        {pluginsQuery.isLoading ? (
          <LoadingState />
        ) : displayedPlugins.length === 0 ? (
          <EmptyState filter={filter} hasQuery={Boolean(debouncedSearch)} />
        ) : (
          <ul className="flex flex-col gap-2">
            {displayedPlugins.map((plugin) => (
              <li key={plugin.id}>
                <PluginRow
                  plugin={plugin}
                  onSelect={() => {
                    /* No detail view yet — row is informational only. */
                  }}
                  onInstall={() => handleInstall(plugin)}
                  onRemove={() => handleRemove(plugin)}
                  isInstalling={installingId === plugin.name}
                  isRemoving={removingId === plugin.name}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      {removalDialog}
    </div>
  );
}

function resolveKind(filter: PluginFilter): "installed" | "available" | undefined {
  switch (filter) {
    case "installed":
      return "installed";
    case "available":
      return "available";
    default:
      return undefined;
  }
}

function sortPlugins(plugins: readonly PluginInfo[]): PluginInfo[] {
  // Installed first, then alphabetical. Matches Skills tab ordering so the
  // two surfaces feel like siblings.
  return [...plugins].sort((a, b) => {
    const aInstalled = isInstalledPlugin(a);
    const bInstalled = isInstalledPlugin(b);
    if (aInstalled !== bInstalled) return aInstalled ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

interface FilterBarProps {
  search: string;
  onSearchChange: Dispatch<SetStateAction<string>>;
  filter: PluginFilter;
  onFilterChange: (f: PluginFilter) => void;
  isSearching: boolean;
}

function FilterBar({
  search,
  onSearchChange,
  filter,
  onFilterChange,
  isSearching,
}: FilterBarProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onSearchChange(e.target.value);
  };

  return (
    <div className="flex items-center gap-3">
      <Input
        type="search"
        value={search}
        onChange={handleChange}
        placeholder="Search Plugins"
        aria-label="Search Plugins"
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
  value: PluginFilter;
  onChange: (v: PluginFilter) => void;
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
          {FILTERS.map((option) => {
            const Icon = option.icon;
            const isSelected = value === option.value;
            return (
              <li key={option.value}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
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
                  {isSelected && (
                    <CheckCircle className="h-3.5 w-3.5" aria-hidden />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </Popover.Content>
    </Popover.Root>
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
  hasQuery,
}: {
  filter: PluginFilter;
  hasQuery: boolean;
}) {
  const { title, subtitle, Icon } = getEmptyStateCopy(filter, hasQuery);
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
  hasQuery: boolean,
): { title: string; subtitle: string; Icon: typeof Puzzle } {
  if (hasQuery) {
    return {
      title: "No plugins match",
      subtitle: "Try a different search term or clearing the filter.",
      Icon: Search,
    };
  }
  switch (filter) {
    case "installed":
      return {
        title: "No Plugins Installed",
        subtitle:
          "Install a plugin from the catalog or use the CLI: assistant plugins install <name>.",
        Icon: Puzzle,
      };
    case "available":
      return {
        title: "No Plugins Available",
        subtitle: "All available plugins have been installed.",
        Icon: CheckCircle,
      };
    default:
      return {
        title: "No Plugins Available",
        subtitle:
          "Check your connection to the canonical plugin catalog, or use the CLI: assistant plugins search.",
        Icon: CloudOff,
      };
  }
}

