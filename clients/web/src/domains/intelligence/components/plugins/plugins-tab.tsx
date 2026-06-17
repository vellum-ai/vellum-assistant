import { useQuery } from "@tanstack/react-query";
import { Loader2, Puzzle, Search, TriangleAlert } from "lucide-react";
import {
    type ChangeEvent,
    type Dispatch,
    type SetStateAction,
    useMemo,
    useState,
} from "react";

import { CatalogRow } from "@/domains/intelligence/components/plugins/catalog-row";
import { PluginRow } from "@/domains/intelligence/components/plugins/plugin-row";
import {
    pluginsGetQueryKey,
    pluginsSearchGetOptions,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { pluginsGet } from "@/generated/daemon/sdk.gen";
import type {
    PluginsGetResponse,
    PluginsSearchGetResponse,
} from "@/generated/daemon/types.gen";
import { Card, Input } from "@vellumai/design-library";

type PluginInfo = PluginsGetResponse["plugins"][number];
type PluginCatalogMatch = PluginsSearchGetResponse["matches"][number];

interface PluginsTabProps {
  assistantId: string;
}

// The installed list (local filesystem) and the catalog (the daemon's
// cached, rate-limited GitHub listing) both change rarely, so each is
// fetched once with no query and filtered in memory as the user types.
// Typing therefore issues zero network requests — and never re-hits the
// daemon's catalog search on every keystroke. `staleTime` keeps the data
// warm across tab switches so revisiting doesn't refetch.
const CATALOG_STALE_TIME_MS = 5 * 60 * 1000; // 5 minutes

/** Case-insensitive substring match against a plugin's name + description. */
function matchesQuery(
  query: string,
  ...fields: readonly (string | null | undefined)[]
): boolean {
  if (!query) return true;
  return fields.some((f) => f?.toLowerCase().includes(query));
}

export function PluginsTab({ assistantId }: PluginsTabProps) {
  const [searchValue, setSearchValue] = useState("");
  const query = searchValue.trim().toLowerCase();

  const pluginsQuery = useQuery({
    queryKey: pluginsGetQueryKey({
      path: { assistant_id: assistantId },
      query: { q: undefined },
    }),
    queryFn: async ({ signal }) => {
      const result = await pluginsGet({
        path: { assistant_id: assistantId },
        query: { q: undefined },
        signal,
        throwOnError: false,
      });
      const status = result.response?.status;
      // Older daemons return 404 when the list endpoint isn't
      // implemented yet — degrade to an empty installed list.
      if (status === 404) return { plugins: [] } as PluginsGetResponse;
      if (!result.response?.ok) throw new Error("Failed to load plugins");
      return result.data ?? ({ plugins: [] } as PluginsGetResponse);
    },
    enabled: Boolean(assistantId),
    staleTime: CATALOG_STALE_TIME_MS,
  });

  const catalogQuery = useQuery({
    ...pluginsSearchGetOptions({
      path: { assistant_id: assistantId },
      query: { q: undefined },
    }),
    enabled: Boolean(assistantId),
    staleTime: CATALOG_STALE_TIME_MS,
  });

  const installedPlugins = useMemo(
    () => sortPlugins(pluginsQuery.data?.plugins ?? []),
    [pluginsQuery.data?.plugins],
  );

  const installedNames = useMemo(
    () => new Set(installedPlugins.map((p) => p.name)),
    [installedPlugins],
  );

  const visibleInstalled = useMemo(
    () =>
      installedPlugins.filter((p) =>
        matchesQuery(query, p.name, p.description),
      ),
    [installedPlugins, query],
  );

  // Catalog entries that aren't already installed and match the filter.
  // The list endpoint and the catalog endpoint are independent — entries
  // the user has installed locally still appear in the catalog.
  // Suppressing them here keeps the "Available to install" section honest.
  const catalogMatches = useMemo<readonly PluginCatalogMatch[]>(() => {
    const matches = catalogQuery.data?.matches ?? [];
    return matches.filter(
      (m) =>
        !installedNames.has(m.name) &&
        matchesQuery(query, m.name, m.description),
    );
  }, [catalogQuery.data?.matches, installedNames, query]);

  // Filtering is in-memory, so the only spinner-worthy work is a background
  // refetch of the underlying lists (initial load uses the LoadingState).
  const isSearching =
    (pluginsQuery.isFetching && !pluginsQuery.isLoading) ||
    (catalogQuery.isFetching && !catalogQuery.isLoading);

  const isLoadingInstalled = pluginsQuery.isLoading;
  const isLoadingCatalog = catalogQuery.isLoading;

  const showInstalledEmpty =
    !isLoadingInstalled && !pluginsQuery.isError && visibleInstalled.length === 0;
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
        ) : pluginsQuery.isError ? (
          <PluginsErrorState />
        ) : showInstalledEmpty ? (
          <InstalledEmptyState hasQuery={Boolean(query)} />
        ) : (
          <ul className="flex flex-col gap-2">
            {visibleInstalled.map((plugin) => (
              <li key={plugin.id}>
                <PluginRow plugin={plugin} assistantId={assistantId} />
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
          <CatalogEmptyState hasQuery={Boolean(query)} />
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
  const title = hasQuery
    ? "No installed plugins match"
    : "No Plugins Installed";
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

function PluginsErrorState() {
  return (
    <Card.Root>
      <Card.Body className="flex flex-col items-center justify-center py-10 text-center">
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
