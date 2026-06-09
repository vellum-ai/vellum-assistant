import { useQuery } from "@tanstack/react-query";
import {
    ChevronDown,
    Loader2,
    Search,
    Sparkles,
} from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";

import { useNavigate, useSearchParams } from "react-router";

import { type Assistant, getAssistant } from "@/assistant/api";
import { IntegrationDetailModal } from "@/domains/settings/components/integration-detail-modal";
import { IntegrationRow } from "@/domains/settings/components/integration-row";
import { assistantsOauthConnectionsListOptions } from "@/generated/api/@tanstack/react-query.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { oauthProvidersGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { captureError } from "@/lib/sentry/capture-error";
import { routes } from "@/utils/routes";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";
import { Popover } from "@vellumai/design-library/components/popover";
import { toast } from "@vellumai/design-library/components/toast";

import {
    getLocalSetting,
    setLocalSetting,
} from "@/utils/local-settings";

const BANNER_STORAGE_KEY = "vellum:integrations:bannerDismissed";

type IntegrationFilter = "all" | "enabled" | "not-enabled";

const FILTER_OPTIONS: Array<{ value: IntegrationFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "enabled", label: "Enabled" },
  { value: "not-enabled", label: "Not Enabled" },
];

function connectionForProvider(
  connections: OAuthConnection[] | undefined,
  providerKey: string,
): OAuthConnection | null {
  return connections?.find((c) => c.provider === providerKey) ?? null;
}

function IntegrationsPanelInner() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const platformGate = usePlatformGate();

  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [assistantLoading, setAssistantLoading] = useState(true);

  const [searchText, setSearchText] = useState("");
  const [selectedFilter, setSelectedFilter] =
    useState<IntegrationFilter>("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);

  const [bannerDismissed, setBannerDismissed] = useState(true);
  const [selectedProviderKey, setSelectedProviderKey] =
    useState<string | null>(null);

  // Hydrate banner dismissal from localStorage on mount.
  useEffect(() => {
    setBannerDismissed(
      getLocalSetting(BANNER_STORAGE_KEY, "false") === "true",
    );
  }, []);

  const dismissBanner = () => {
    setBannerDismissed(true);
    setLocalSetting(BANNER_STORAGE_KEY, "true");
  };

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = await getAssistant();
        if (active && result.ok) {
          setAssistant(result.data);
        }
      } catch (error) {
        captureError(error, { context: "integrations.getAssistant" });
      } finally {
        if (active) {
          setAssistantLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const {
    data: providers,
    isLoading: providersLoading,
    isError: providersError,
  } = useQuery({
    ...oauthProvidersGetOptions({
      path: { assistant_id: assistant?.id ?? "" },
    }),
    select: (data) => data.providers,
    enabled: !!assistant,
  });

  const { data: connections, isLoading: connectionsLoading } = useQuery({
    ...assistantsOauthConnectionsListOptions({
      path: { assistant_id: assistant?.id ?? "" },
    }),
    enabled: !!assistant && platformGate === "full",
  });

  // Handle OAuth callback query params.
  useEffect(() => {
    const oauthStatus = searchParams.get("oauth_status");
    if (!oauthStatus) {
      return;
    }

    const oauthProvider = searchParams.get("oauth_provider");
    const providerLabel = oauthProvider
      ? oauthProvider.charAt(0).toUpperCase() + oauthProvider.slice(1)
      : null;

    if (oauthStatus === "connected") {
      toast.success(
        providerLabel
          ? `${providerLabel} account connected successfully.`
          : "Account connected successfully.",
      );
    } else if (oauthStatus === "error") {
      const code = searchParams.get("oauth_code") ?? "unknown";
      const messages: Record<string, string> = {
        denied: "Authorization was denied. Please try again.",
        state_invalid: "Authorization state was invalid. Please try again.",
        state_expired: "Authorization expired. Please try again.",
        exchange_failed: "Failed to complete authorization. Please try again.",
        identity_failed:
          "Failed to verify account identity. Please try again.",
      };
      toast.error(
        messages[code] ??
          (providerLabel
            ? `Failed to connect ${providerLabel}.`
            : "Failed to connect. Please try again."),
      );
    }

    navigate(routes.settings.integrations, { replace: true });
  }, [searchParams, navigate]);

  const managedProviders = useMemo(
    () => providers?.filter((p) => p.supports_managed_mode) ?? [],
    [providers],
  );

  const filteredProviders = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    let list = managedProviders.filter((provider) => {
      if (!needle) {
        return true;
      }
      const name = (provider.display_name ?? provider.provider_key).toLowerCase();
      const description = (provider.description ?? "").toLowerCase();
      return name.includes(needle) || description.includes(needle);
    });

    if (selectedFilter !== "all") {
      list = list.filter((provider) => {
        const connected = Boolean(
          connectionForProvider(connections, provider.provider_key)?.connected,
        );
        return selectedFilter === "enabled" ? connected : !connected;
      });
    }

    return [...list].sort((a, b) => {
      const aEnabled = Boolean(
        connectionForProvider(connections, a.provider_key)?.connected,
      );
      const bEnabled = Boolean(
        connectionForProvider(connections, b.provider_key)?.connected,
      );
      if (aEnabled !== bEnabled) {
        return aEnabled ? -1 : 1;
      }
      const aName = (a.display_name ?? a.provider_key).toLowerCase();
      const bName = (b.display_name ?? b.provider_key).toLowerCase();
      return aName.localeCompare(bName);
    });
  }, [managedProviders, connections, searchText, selectedFilter]);

  const loading = assistantLoading || providersLoading || connectionsLoading;
  const selectedFilterLabel =
    FILTER_OPTIONS.find((o) => o.value === selectedFilter)?.label ?? "All";

  const emptyStateTitle = (() => {
    if (searchText.trim()) {
      return "No integrations matched";
    }
    switch (selectedFilter) {
      case "enabled":
        return "No Enabled Integrations";
      case "not-enabled":
        return "All Integrations Are Enabled";
      default:
        return "No Integrations Available";
    }
  })();

  const emptyStateSubtitle = (() => {
    if (searchText.trim()) {
      return `No integrations matched "${searchText.trim()}"`;
    }
    switch (selectedFilter) {
      case "enabled":
        return "Connect an integration to get started.";
      case "not-enabled":
        return "All available integrations have been connected.";
      default:
        return "Check your connection and try again.";
    }
  })();

  const selectedProvider = useMemo(
    () =>
      selectedProviderKey
        ? managedProviders.find(
            (p) => p.provider_key === selectedProviderKey,
          ) ?? null
        : null,
    [managedProviders, selectedProviderKey],
  );
  return (
    <div className="space-y-4">
      {!bannerDismissed && (
        <Notice
          tone="info"
          icon={<Sparkles className="h-3.5 w-3.5" />}
          onDismiss={dismissBanner}
        >
          <span className="text-body-medium-default">Tip:</span> You can enable
          integrations by mentioning them in chat.
        </Notice>
      )}

      <div className="flex items-center gap-2">
        <Input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search Integrations"
          aria-label="Search integrations"
          leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
          fullWidth
          wrapperClassName="flex-1"
        />
        <Popover.Root open={filterMenuOpen} onOpenChange={setFilterMenuOpen}>
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={filterMenuOpen}
              className="flex w-36 cursor-pointer items-center justify-between gap-2 rounded-md border border-[var(--border-element)] bg-[var(--surface-lift)] px-3 py-1.5 text-body-medium-lighter text-[var(--content-default)] transition-colors hover:bg-[var(--ghost-hover)]"
            >
              <span>{selectedFilterLabel}</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </Popover.Trigger>
          <Popover.Content
            align="end"
            sideOffset={4}
            className="w-36 overflow-hidden p-0"
          >
            <div role="listbox">
              {FILTER_OPTIONS.map((option) => {
                const active = option.value === selectedFilter;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      setSelectedFilter(option.value);
                      setFilterMenuOpen(false);
                    }}
                    className={`flex w-full cursor-pointer items-center px-3 py-1.5 text-left hover:bg-[var(--ghost-hover)] ${
                      active
                        ? "text-body-medium-default text-[var(--content-default)]"
                        : "text-body-medium-lighter text-[var(--content-default)]"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </Popover.Content>
        </Popover.Root>
      </div>

      <div>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-body-medium-lighter text-[var(--content-tertiary)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading...</span>
          </div>
        ) : providersError ? (
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            Failed to load integrations. Please try again.
          </p>
        ) : !assistant ? (
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            No assistant found. Hatch an assistant to connect integrations.
          </p>
        ) : filteredProviders.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--border-element)] px-4 py-12 text-center">
            <Search className="h-6 w-6 text-[var(--content-disabled)]" />
            <p className="text-body-medium-default text-[var(--content-default)]">
              {emptyStateTitle}
            </p>
            <p className="text-body-small-default text-[var(--content-tertiary)]">
              {emptyStateSubtitle}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredProviders.map((provider) => (
              <IntegrationRow
                key={provider.provider_key}
                assistantId={assistant.id}
                providerKey={provider.provider_key}
                displayName={
                  provider.display_name ?? provider.provider_key
                }
                description={provider.description}
                logoUrl={provider.logo_url}
                connection={connectionForProvider(
                  connections,
                  provider.provider_key,
                )}
                platformGate={platformGate}
                onConfigure={() =>
                  setSelectedProviderKey(provider.provider_key)
                }
              />
            ))}
          </div>
        )}
      </div>

      {selectedProvider && assistant && (
        <IntegrationDetailModal
          assistantId={assistant.id}
          providerKey={selectedProvider.provider_key}
          displayName={
            selectedProvider.display_name ?? selectedProvider.provider_key
          }
          description={selectedProvider.description}
          logoUrl={selectedProvider.logo_url}
          platformGate={platformGate}
          onClose={() => setSelectedProviderKey(null)}
        />
      )}
    </div>
  );
}

export function IntegrationsPage() {
  return (
    <div className="space-y-6">
      <Suspense>
        <IntegrationsPanelInner />
      </Suspense>
    </div>
  );
}
