import { useQuery } from "@tanstack/react-query";
import { Tabs } from "@vellumai/design-library/components/tabs";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";
import {
  Select,
  type SelectOption,
} from "@vellumai/design-library/components/select";
import { toast } from "@vellumai/design-library/components/toast";
import { Loader2, Search, Sparkles } from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { type Assistant, getAssistant } from "@/assistant/api";
import { IntegrationDetailModal } from "@/domains/settings/components/integration-detail-modal";
import { IntegrationRow } from "@/domains/settings/components/integration-row";
import { McpPage } from "@/domains/settings/mcp/mcp-page";
import { assistantsOauthConnectionsListOptions } from "@/generated/api/@tanstack/react-query.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import { oauthProvidersGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { usePlatformAssistantId } from "@/hooks/use-platform-assistant-id";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { captureError } from "@/lib/sentry/capture-error";
import { Trans, useTranslation } from "@/i18n";
import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { routes } from "@/utils/routes";

const BANNER_STORAGE_KEY = "vellum:integrations:bannerDismissed";

type IntegrationFilter = "all" | "enabled" | "not-enabled";
type IntegrationsTab = "oauth" | "mcp";

type SettingsTranslate = ReturnType<typeof useTranslation<"settings">>["t"];

function oauthErrorMessage(
  t: SettingsTranslate,
  code: string,
): string | undefined {
  const messages: Record<string, string> = {
    denied: t("integrationsPage.oauthErrorDenied"),
    state_invalid: t("integrationsPage.oauthErrorStateInvalid"),
    state_expired: t("integrationsPage.oauthErrorStateExpired"),
    exchange_failed: t("integrationsPage.oauthErrorExchangeFailed"),
    identity_failed: t("integrationsPage.oauthErrorIdentityFailed"),
  };
  return messages[code];
}

function emptyStateTitle(
  t: SettingsTranslate,
  searchText: string,
  selectedFilter: IntegrationFilter,
): string {
  if (searchText.trim()) {
    return t("integrationsPage.emptySearchTitle");
  }
  switch (selectedFilter) {
    case "enabled":
      return t("integrationsPage.emptyEnabledTitle");
    case "not-enabled":
      return t("integrationsPage.emptyAllEnabledTitle");
    default:
      return t("integrationsPage.emptyDefaultTitle");
  }
}

function emptyStateSubtitle(
  t: SettingsTranslate,
  searchText: string,
  selectedFilter: IntegrationFilter,
): string {
  if (searchText.trim()) {
    return t("integrationsPage.emptySearchSubtitle", {
      query: searchText.trim(),
    });
  }
  switch (selectedFilter) {
    case "enabled":
      return t("integrationsPage.emptyEnabledSubtitle");
    case "not-enabled":
      return t("integrationsPage.emptyNotEnabledSubtitle");
    default:
      return t("integrationsPage.emptyDefaultSubtitle");
  }
}

/** Filter values in display order, each with the catalog key for its label. */
const FILTER_OPTION_KEYS = [
  { value: "all", labelKey: "integrationsPage.filterAll" },
  { value: "enabled", labelKey: "integrationsPage.filterEnabled" },
  { value: "not-enabled", labelKey: "integrationsPage.filterNotEnabled" },
] as const satisfies ReadonlyArray<{
  value: IntegrationFilter;
  labelKey: string;
}>;

function connectionForProvider(
  connections: OAuthConnection[] | undefined,
  providerKey: string,
): OAuthConnection | null {
  return connections?.find((c) => c.provider === providerKey) ?? null;
}

function parseIntegrationsTab(value: string | null): IntegrationsTab {
  return value === "mcp" ? "mcp" : "oauth";
}

function IntegrationsPanelInner() {
  const { t } = useTranslation("settings");
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const platformGate = usePlatformGate();

  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [assistantLoading, setAssistantLoading] = useState(true);

  const [searchText, setSearchText] = useState("");
  const [selectedFilter, setSelectedFilter] =
    useState<IntegrationFilter>("all");

  const [bannerDismissed, setBannerDismissed] = useState(true);
  const [selectedProviderKey, setSelectedProviderKey] = useState<string | null>(
    null,
  );

  // Hydrate banner dismissal from localStorage on mount.
  useEffect(() => {
    setBannerDismissed(getLocalSetting(BANNER_STORAGE_KEY, "false") === "true");
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

  const { platformAssistantId, isLoading: platformAssistantIdLoading } =
    usePlatformAssistantId(assistant?.id, platformGate === "full");

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
      path: { assistant_id: platformAssistantId ?? "" },
    }),
    enabled: !!platformAssistantId && platformGate === "full",
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
          ? t("integrationsPage.accountConnectedToast", { providerLabel })
          : t("integrationsPage.accountConnectedToastGeneric"),
      );
    } else if (oauthStatus === "error") {
      const code = searchParams.get("oauth_code") ?? "unknown";
      toast.error(
        oauthErrorMessage(t, code) ??
          (providerLabel
            ? t("integrationsPage.connectFailedToast", { providerLabel })
            : t("integrationsPage.connectFailedToastGeneric")),
      );
    }

    navigate(routes.settings.integrations, { replace: true });
  }, [searchParams, navigate, t]);

  const managedProviders = useMemo(
    () => providers?.filter((p) => p.supports_managed_mode) ?? [],
    [providers],
  );

  const filteredProviders = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    let list = managedProviders.filter((provider) => {
      if (provider.provider_key === "slack") {
        return false;
      }
      if (!needle) {
        return true;
      }
      const name = (
        provider.display_name ?? provider.provider_key
      ).toLowerCase();
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

  const loading =
    assistantLoading ||
    providersLoading ||
    connectionsLoading ||
    platformAssistantIdLoading;

  const emptyTitle = emptyStateTitle(t, searchText, selectedFilter);
  const emptySubtitle = emptyStateSubtitle(t, searchText, selectedFilter);

  const selectedProvider = useMemo(
    () =>
      selectedProviderKey
        ? (managedProviders.find(
            (p) => p.provider_key === selectedProviderKey,
          ) ?? null)
        : null,
    [managedProviders, selectedProviderKey],
  );

  const filterOptions: ReadonlyArray<SelectOption<IntegrationFilter>> =
    FILTER_OPTION_KEYS.map(({ value, labelKey }) => ({
      value,
      label: t(labelKey),
    }));

  return (
    <div className="space-y-4">
      {!bannerDismissed && (
        <Notice
          tone="info"
          icon={<Sparkles className="h-3.5 w-3.5" />}
          onDismiss={dismissBanner}
        >
          <Trans
            ns="settings"
            i18nKey="integrationsPage.tipBanner"
            components={{
              tip: <span className="text-body-medium-default" />,
            }}
          />
        </Notice>
      )}

      <div className="flex items-center gap-2">
        <Input
          type="text"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder={t("integrationsPage.searchPlaceholder")}
          aria-label={t("integrationsPage.searchAriaLabel")}
          leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
          fullWidth
          wrapperClassName="flex-1"
        />
        <Select<IntegrationFilter>
          options={filterOptions}
          value={selectedFilter}
          onChange={setSelectedFilter}
          aria-label={t("integrationsPage.filterAriaLabel")}
          menuAlign="end"
          className="w-36 shrink-0"
        />
      </div>

      <div>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-body-medium-lighter text-[var(--content-tertiary)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{t("integrationsPage.loading")}</span>
          </div>
        ) : providersError ? (
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            {t("integrationsPage.loadFailed")}
          </p>
        ) : !assistant ? (
          <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
            {t("integrationsPage.noAssistant")}
          </p>
        ) : filteredProviders.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-[var(--border-element)] px-4 py-12 text-center">
            <Search className="h-6 w-6 text-[var(--content-disabled)]" />
            <p className="text-body-medium-default text-[var(--content-default)]">
              {emptyTitle}
            </p>
            <p className="text-body-small-default text-[var(--content-tertiary)]">
              {emptySubtitle}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {filteredProviders.map((provider) => (
              <IntegrationRow
                key={provider.provider_key}
                platformAssistantId={platformAssistantId ?? assistant.id}
                providerKey={provider.provider_key}
                displayName={provider.display_name ?? provider.provider_key}
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
          platformAssistantId={platformAssistantId ?? assistant.id}
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
  const { t } = useTranslation("settings");
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = parseIntegrationsTab(searchParams.get("tab"));

  const handleTabChange = (value: string) => {
    const nextTab = parseIntegrationsTab(value);
    const next = new URLSearchParams(searchParams);
    if (nextTab === "mcp") {
      next.set("tab", "mcp");
    } else {
      next.delete("tab");
    }
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="space-y-6">
      <Tabs.Root value={activeTab} onValueChange={handleTabChange}>
        <Tabs.List>
          <Tabs.Trigger value="oauth">
            {t("integrationsPage.tabOAuth")}
          </Tabs.Trigger>
          <Tabs.Trigger value="mcp">{t("integrationsPage.tabMcp")}</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Panel value="oauth" className="pt-4">
          <Suspense>
            <IntegrationsPanelInner />
          </Suspense>
        </Tabs.Panel>
        <Tabs.Panel value="mcp" className="pt-4">
          <McpPage />
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}
