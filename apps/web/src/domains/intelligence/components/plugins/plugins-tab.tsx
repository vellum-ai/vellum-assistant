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
import { CatalogRow } from "@/domains/intelligence/components/plugins/catalog-row";
import { PluginRow } from "@/domains/intelligence/components/plugins/plugin-row";
import {
  fetchPluginCatalog,
  fetchPlugins,
} from "@/domains/intelligence/plugins/api";
import type {
  PluginCatalogMatch,
  PluginInfo,
} from "@/domains/intelligence/plugins/types";

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

  const catalogQuery = useQuery({
    queryKey: ["assistantPluginCatalog", assistantId, { q: debouncedSearch }],
    queryFn: () =>
      fetchPluginCatalog(assistantId, {
        query: debouncedSearch || undefined,
      }),
    enabled: Boolean(assistantId),
  });

  const installedPlugins = useMemo(
    () => sortPlugins(pluginsQuery.data?.plugins ?? []),
    [pluginsQuery.data?.plugins],
  );

  const installedNames = useMemo(
    () => new Set(installedPlugins.map((p) => p.name)),
    [installedPlugins],
  );

  // Catalog entries that aren't already installed. The list endpoint
  // and the catalog endpoint are independent — entries the user has
  // installed locally still appear in the catalog. Suppressing them
  // here keeps the "Available to install" section honest.
  const catalogMatches = useMemo<readonly PluginCatalogMatch[]>(() => {
    const matches = catalogQuery.data?.matches ?? [];
    return matches.filter((m) => !installedNames.has(m.name));
  }, [catalogQuery.data?.matches, installedNames]);

  const isSearchingInstalled =
    pluginsQuery.isFetching && Boolean(debouncedSearch);
  const isSearchingCatalog =
    catalogQuery.isFetching && Boolean(debouncedSearch);
  const isSearching = isSearchingInstalled || isSearchingCatalog;

  const isLoadingInstalled = pluginsQuery.isLoading;
  const isLoadingCatalog = catalogQuery.isLoading;

  const showInstalledEmpty =
    !isLoadingInstalled && installedPlugins.length === 0;
  const showCatalogEmpty = !isLoadingCatalog && catalogMatches.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
      <FilterBar
        search={searchValue}
        onSearchChange={setSearchValue}
        isSearching={isSearching}
      />

      <div className="min-w-0 flex-1 overflow-y-auto">
        <SectionHeader title="Installed" />
        {isLoadingInstalled ? (
          <LoadingState />
        ) : showInstalledEmpty ? (
          <InstalledEmptyState hasQuery={Boolean(debouncedSearch)} />
        ) : (
          <ul className="flex flex-col gap-2">
            {installedPlugins.map((plugin) => (
              <li key={plugin.id}>
                <PluginRow plugin={plugin} />
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6" />
        <SectionHeader title="Available to install" />
        {isLoadingCatalog ? (
          <LoadingState />
        ) : catalogQuery.isError ? (
          <CatalogErrorState />
        ) : showCatalogEmpty ? (
          <CatalogEmptyState hasQuery={Boolean(debouncedSearch)} />
        ) : (
          <ul className="flex flex-col gap-2">
            {catalogMatches.map((match) => (
              <li key={match.path}>
                <CatalogRow match={match} />
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

function SectionHeader({ title }: { title: string }) {
  return (
    <h3
      className="mb-2 text-body-small-default uppercase tracking-wide"
      style={{ color: "var(--content-tertiary)" }}
    >
      {title}
    </h3>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-8">
      <Loader2
        className="h-6 w-6 animate-spin"
        style={{ color: "var(--content-tertiary)" }}
      />
    </div>
  );
}

function InstalledEmptyState({ hasQuery }: { hasQuery: boolean }) {
  const title = hasQuery ? "No installed plugins match" : "No Plugins Installed";
  const subtitle = hasQuery
    ? "Try a different search term, or browse the catalog below."
    : "Install a plugin with the CLI, or browse the catalog below.";
  const Icon = hasQuery ? Search : Puzzle;

  return (
    <Card.Root>
      <Card.Body className="flex flex-col items-center justify-center py-10 text-center">
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

function CatalogEmptyState({ hasQuery }: { hasQuery: boolean }) {
  const title = hasQuery ? "No catalog entries match" : "Catalog is empty";
  const subtitle = hasQuery
    ? "Try a different search term, or remove the filter to browse everything."
    : "No plugins are currently published in the catalog.";

  return (
    <Card.Root>
      <Card.Body className="flex flex-col items-center justify-center py-10 text-center">
        <Search
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

function CatalogErrorState() {
  return (
    <Card.Root>
      <Card.Body className="flex flex-col items-center justify-center py-10 text-center">
        <Puzzle
          className="mb-3 h-8 w-8"
          style={{ color: "var(--content-tertiary)" }}
          aria-hidden
        />
        <h3
          className="text-title-small"
          style={{ color: "var(--content-default)" }}
        >
          Couldn&apos;t load catalog
        </h3>
        <p
          className="mt-1 max-w-sm text-body-medium-lighter"
          style={{ color: "var(--content-tertiary)" }}
        >
          Catalog browsing is temporarily unavailable. Installed plugins are
          still listed above.
        </p>
      </Card.Body>
    </Card.Root>
  );
}
