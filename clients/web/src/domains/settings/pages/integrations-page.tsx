import { useQuery } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";
import { Select } from "@vellumai/design-library/components/select";
import { toast } from "@vellumai/design-library/components/toast";
import { Loader2, Plus, RefreshCw, Search } from "lucide-react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { assistantsOauthConnectionsListOptions } from "@/generated/api/@tanstack/react-query.gen";
import { oauthProvidersGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { usePlatformAssistantId } from "@/hooks/use-platform-assistant-id";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { useTranslation } from "@/i18n";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { navigateToNewConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

import { IntegrationDetailModal } from "../components/integration-detail-modal";
import { IntegrationMethodsModal } from "../components/integration-methods-modal";
import { IntegrationRow } from "../components/integration-row";
import {
  catalogDefinitionKey,
  catalogMethodServers,
  buildIntegrationItems,
  filterIntegrationItems,
  type IntegrationFilter,
} from "../integration-items";
import type { McpCatalogEntry } from "../mcp/mcp-catalog-api";
import { CatalogIntegrationRow } from "../mcp/catalog-integration-row";
import { McpCatalogSetupModal } from "../mcp/mcp-catalog-setup-modal";
import { McpConnectionDialogs } from "../mcp/mcp-connection-dialogs";
import { McpServerCard } from "../mcp/mcp-server-card";
import { useMcpConnections } from "../mcp/use-mcp-connections";

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

function IntegrationsPanelInner({ assistantId }: { assistantId: string }) {
  const { t } = useTranslation("settings");
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const platformGate = usePlatformGate();
  const orgReady = useIsOrgReady();
  const allowAdd = useAssistantFeatureFlagStore.use.mcpAddServer();
  const flagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const [searchText, setSearchText] = useState("");
  const [selectedFilter, setSelectedFilter] =
    useState<IntegrationFilter>("all");
  const [selectedProviderKey, setSelectedProviderKey] = useState<string | null>(
    searchParams.get("provider"),
  );
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [setupEntryKey, setSetupEntryKey] = useState<string | null>(null);
  const mcp = useMcpConnections(assistantId);
  const setupEntry = mcp.catalog.data?.entries.find(
    (entry) => catalogDefinitionKey(entry) === setupEntryKey,
  );

  const {
    platformAssistantId,
    isLoading: platformIdLoading,
    error: platformIdError,
  } = usePlatformAssistantId(assistantId, platformGate === "full" && orgReady);
  const providers = useQuery({
    ...oauthProvidersGetOptions({ path: { assistant_id: assistantId } }),
    select: (data) => data.providers,
    enabled: orgReady,
  });
  const connections = useQuery({
    ...assistantsOauthConnectionsListOptions({
      path: { assistant_id: platformAssistantId ?? "" },
    }),
    enabled:
      Boolean(platformAssistantId) && platformGate === "full" && orgReady,
  });

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
      toast.error(
        oauthErrorMessage(t, searchParams.get("oauth_code") ?? "unknown") ??
          (providerLabel
            ? t("integrationsPage.connectFailedToast", { providerLabel })
            : t("integrationsPage.connectFailedToastGeneric")),
      );
    }
    navigate(routes.settings.integrations, { replace: true });
  }, [searchParams, navigate, t]);

  const allItems = useMemo(
    () =>
      buildIntegrationItems(
        providers.data ?? [],
        connections.data ?? [],
        mcp.list.data?.servers ?? [],
        mcp.catalog.data?.supportsConnect ? mcp.catalog.data.entries : [],
      ),
    [providers.data, connections.data, mcp.list.data, mcp.catalog.data],
  );
  const items = useMemo(
    () => filterIntegrationItems(allItems, searchText, selectedFilter),
    [allItems, searchText, selectedFilter],
  );
  const selectedItem = allItems.find((item) => item.id === selectedItemId);
  const selectedProvider = providers.data?.find(
    (provider) => provider.provider_key === selectedProviderKey,
  );
  const loading =
    providers.isLoading ||
    connections.isLoading ||
    platformIdLoading ||
    mcp.list.isLoading ||
    (allItems.length === 0 && mcp.catalog.isLoading);
  const oauthError =
    providers.isError || connections.isError || Boolean(platformIdError);
  const authBusy = mcp.auth.isBusy;

  const connectCatalog = (entry: McpCatalogEntry) => {
    if (entry.setup.instructions || entry.setup.mode === "manual") {
      setSetupEntryKey(catalogDefinitionKey(entry));
    } else {
      mcp.connectCatalog(entry);
    }
  };

  const addCustom = () => {
    if (allowAdd) {
      mcp.setAddOpen(true);
    } else {
      navigateToNewConversation(navigate, { prompt: t("mcpPage.setupPrompt") });
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Input
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder={t("integrationsPage.searchPlaceholder")}
          aria-label={t("integrationsPage.searchAriaLabel")}
          leftIcon={<Search aria-hidden className="size-4" />}
          className="min-h-11"
          fullWidth
        />
        <Select<IntegrationFilter>
          options={[
            { value: "all", label: t("integrationsPage.filterAll") },
            {
              value: "connected",
              label: t("integrationsPage.filterConnected"),
            },
            {
              value: "available",
              label: t("integrationsPage.filterAvailable"),
            },
          ]}
          value={selectedFilter}
          onChange={setSelectedFilter}
          aria-label={t("integrationsPage.filterAriaLabel")}
          menuAlign="end"
          className="[&>button]:min-h-11"
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="outlined"
          className="min-h-11"
          leftIcon={<Plus />}
          onClick={addCustom}
          disabled={!orgReady || !flagsHydrated || authBusy}
        >
          {t("integrationsPage.addCustom")}
        </Button>
        <Button
          variant="ghost"
          className="min-h-11 min-w-11"
          iconOnly={
            <RefreshCw
              className={mcp.reload.isPending ? "animate-spin" : undefined}
            />
          }
          aria-label={t("mcpPage.reloadButton")}
          tooltip={t("mcpPage.reloadButton")}
          disabled={!orgReady || mcp.reload.isPending}
          onClick={() => mcp.reload.mutate()}
        />
      </div>
      {oauthError ? (
        <Notice tone="warning">{t("integrationsPage.oauthUnavailable")}</Notice>
      ) : null}
      {mcp.list.isError ? (
        <Notice
          tone="warning"
          actions={
            <Button variant="ghost" onClick={() => void mcp.list.refetch()}>
              {t("mcpConnect.retry")}
            </Button>
          }
        >
          {t("integrationsPage.mcpUnavailable")}
        </Notice>
      ) : null}
      {mcp.catalog.isError ? (
        <Notice
          tone="warning"
          actions={
            <Button variant="ghost" onClick={() => void mcp.catalog.refetch()}>
              {t("mcpConnect.retry")}
            </Button>
          }
        >
          {t("mcpCatalog.unavailable")}
        </Notice>
      ) : null}
      <McpConnectionDialogs connections={mcp} allowAdd={allowAdd} />
      {loading ? (
        <div
          role="status"
          className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]"
        >
          <Loader2 className="size-4 animate-spin" />
          {t("integrationsPage.loading")}
        </div>
      ) : null}
      <div className="space-y-2">
        {items.map((item) =>
          item.kind === "oauth" ? (
            <IntegrationRow
              key={item.id}
              providerKey={item.provider.provider_key}
              displayName={item.name}
              description={item.provider.description}
              logoUrl={item.provider.logo_url}
              connections={item.connections}
              mcpServers={catalogMethodServers(item.methods)}
              disabled={
                !orgReady ||
                (item.methods.length === 0 &&
                  platformGate === "full" &&
                  !platformAssistantId)
              }
              onConfigure={() =>
                item.methods.length > 0
                  ? setSelectedItemId(item.id)
                  : setSelectedProviderKey(item.provider.provider_key)
              }
            />
          ) : item.kind === "catalog" ? (
            <CatalogIntegrationRow
              key={item.id}
              method={item.method}
              connections={mcp}
              onOpen={() => setSelectedItemId(item.id)}
              onConnect={() => connectCatalog(item.method.definition)}
            />
          ) : (
            <McpServerCard
              key={item.id}
              server={item.server}
              displayName={mcp.serverInstanceDisplayName(item.server.id)}
              onRemove={mcp.setRemoveServerId}
              onConfigure={mcp.setConfigureServerId}
              onAuthenticate={mcp.connectServer}
              onManagePlugin={(pluginName) =>
                navigate(
                  pluginName
                    ? `${routes.plugins}/${encodeURIComponent(pluginName)}`
                    : routes.plugins,
                )
              }
              isAuthenticating={
                mcp.auth.attempt?.serverId === item.server.id && authBusy
              }
              connectDisabled={!orgReady || authBusy}
            />
          ),
        )}
      </div>
      {!loading && items.length === 0 ? (
        <p className="py-8 text-center text-body-medium-default text-[var(--content-tertiary)]">
          {searchText.trim()
            ? t("integrationsPage.emptySearchSubtitle", {
                query: searchText.trim(),
              })
            : t("integrationsPage.emptyFilter")}
        </p>
      ) : null}
      {selectedItem && selectedItem.kind !== "mcp" ? (
        <IntegrationMethodsModal
          item={selectedItem}
          mcp={mcp}
          oauthDisabled={
            !orgReady || (platformGate === "full" && !platformAssistantId)
          }
          onOAuth={setSelectedProviderKey}
          onCatalog={connectCatalog}
          onClose={() => setSelectedItemId(null)}
        />
      ) : null}
      {setupEntry ? (
        <McpCatalogSetupModal
          key={`${assistantId}:${setupEntry.id}:${setupEntry.serverKey}`}
          assistantId={assistantId}
          entry={setupEntry}
          onClose={() => setSetupEntryKey(null)}
          onConnect={(acknowledged) => {
            mcp.connectCatalog(setupEntry, acknowledged);
            setSetupEntryKey(null);
          }}
        />
      ) : null}
      {selectedProvider && (platformGate !== "full" || platformAssistantId) ? (
        <IntegrationDetailModal
          assistantId={assistantId}
          platformAssistantId={platformAssistantId ?? assistantId}
          providerKey={selectedProvider.provider_key}
          displayName={
            selectedProvider.display_name ?? selectedProvider.provider_key
          }
          description={selectedProvider.description}
          logoUrl={selectedProvider.logo_url}
          platformGate={platformGate}
          onClose={() => setSelectedProviderKey(null)}
        />
      ) : null}
    </div>
  );
}

export function IntegrationsPage() {
  const assistantId = useActiveAssistantId();
  return (
    <Suspense>
      <IntegrationsPanelInner key={assistantId} assistantId={assistantId} />
    </Suspense>
  );
}
