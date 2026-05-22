import { useQuery } from "@tanstack/react-query";
import { Loader2, Puzzle, Search } from "lucide-react";
import {
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useState,
} from "react";

import { Card, Input } from "@vellum/design-library";
import { PluginRow } from "@/domains/intelligence/components/plugins/plugin-row.js";
import { fetchPlugins } from "@/domains/intelligence/plugins/api.js";
import type { PluginInfo } from "@/domains/intelligence/plugins/types.js";

interface PluginsTabProps {
  assistantId: string;
}

const SEARCH_DEBOUNCE_MS = 300;

export function PluginsTab({ assistantId }: PluginsTabProps) {
  const [searchValue, setSearchValue] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(searchValue.trim());
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchValue]);

  const pluginsQuery = useQuery({
    queryKey: ["assistantPlugins", assistantId, { q: debouncedSearch }],
    queryFn: () =>
      fetchPlugins(assistantId, {
        query: debouncedSearch || undefined,
      }),
    enabled: Boolean(assistantId),
  });

  const allPlugins = useMemo(
    () => pluginsQuery.data?.plugins ?? [],
    [pluginsQuery.data?.plugins],
  );

  const displayedPlugins = useMemo(
    () => sortPlugins(allPlugins),
    [allPlugins],
  );

  const isSearching = pluginsQuery.isFetching && Boolean(debouncedSearch);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
      <FilterBar
        search={searchValue}
        onSearchChange={setSearchValue}
        isSearching={isSearching}
      />

      <div className="min-w-0 flex-1 overflow-y-auto">
        {pluginsQuery.isLoading ? (
          <LoadingState />
        ) : displayedPlugins.length === 0 ? (
          <EmptyState hasQuery={Boolean(debouncedSearch)} />
        ) : (
          <ul className="flex flex-col gap-2">
            {displayedPlugins.map((plugin) => (
              <li key={plugin.id}>
                <PluginRow plugin={plugin} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function sortPlugins(plugins: readonly PluginInfo[]): PluginInfo[] {
  // Alphabetical by name. Stable ordering matches the CLI's
  // `assistant plugins list`, so the surfaces agree on what's present.
  return [...plugins].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

interface FilterBarProps {
  search: string;
  onSearchChange: Dispatch<SetStateAction<string>>;
  isSearching: boolean;
}

function FilterBar({ search, onSearchChange, isSearching }: FilterBarProps) {
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

function EmptyState({ hasQuery }: { hasQuery: boolean }) {
  const title = hasQuery ? "No plugins match" : "No Plugins Installed";
  const subtitle = hasQuery
    ? "Try a different search term."
    : "Install a plugin with the CLI: assistant plugins install <name>.";
  const Icon = hasQuery ? Search : Puzzle;

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
