import { useQuery } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";
import { Loader2, Plus, Search } from "lucide-react";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate, useSearchParams } from "react-router";

import { type Assistant, getAssistant } from "@/assistant/api";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { assistantsOauthConnectionsListOptions } from "@/generated/api/@tanstack/react-query.gen";
import { oauthProvidersGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { usePlatformAssistantId } from "@/hooks/use-platform-assistant-id";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { navigateToNewConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

import { IntegrationDetailModal } from "../components/integration-detail-modal";
import { IntegrationRow } from "../components/integration-row";
import {
  buildIntegrationItems,
  filterIntegrationItems,
  type IntegrationItem,
} from "../integration-items";
import { McpConnectionDialogs } from "../mcp/mcp-connection-dialogs";
import { McpServerCard } from "../mcp/mcp-server-card";
import { useMcpConnections } from "../mcp/use-mcp-connections";

type SettingsTranslate = ReturnType<typeof useTranslation<"settings">>["t"];

const CONFIGURED_GRID =
  "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,22rem),1fr))]";
const AVAILABLE_GRID =
  "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]";

function IntegrationSection({
  title,
  count,
  gridClassName,
  children,
}: {
  title: string;
  count: number;
  gridClassName: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-title-small text-[var(--content-default)]">
        {title}
        <span className="text-body-medium-lighter text-[var(--content-tertiary)]">
          {count}
        </span>
      </h2>
      <div className={gridClassName}>{children}</div>
    </section>
  );
}

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

function IntegrationsPanelInner({ mcpAssistantId }: { mcpAssistantId: string }) {
  const { t } = useTranslation("settings");
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const platformGate = usePlatformGate();
  const allowAdd = useAssistantFeatureFlagStore.use.mcpAddServer();
  const flagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [assistantLoading, setAssistantLoading] = useState(true);
  const [searchText, setSearchText] = useState("");
  const providerParam = searchParams.get("provider");
  const [selectedProviderKey, setSelectedProviderKey] = useState<string | null>(
    providerParam,
  );
  const previousProviderParam = useRef(providerParam);
  const mcp = useMcpConnections(mcpAssistantId);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const result = await getAssistant(mcpAssistantId);
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
  }, [mcpAssistantId]);

  useEffect(() => {
    if (providerParam === previousProviderParam.current) {
      return;
    }
    previousProviderParam.current = providerParam;
    setSelectedProviderKey(providerParam);
  }, [providerParam]);

  const closeProvider = useCallback(() => {
    setSelectedProviderKey(null);
    if (!searchParams.has("provider")) {
      return;
    }
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("provider");
    setSearchParams(nextSearchParams, { replace: true });
  }, [searchParams, setSearchParams]);

  const {
    platformAssistantId,
    isLoading: platformAssistantIdLoading,
    error: platformAssistantIdError,
  } = usePlatformAssistantId(assistant?.id, platformGate === "full");
  const providers = useQuery({
    ...oauthProvidersGetOptions({
      path: { assistant_id: assistant?.id ?? "" },
    }),
    select: (data) => data.providers,
    enabled: Boolean(assistant),
  });
  const connections = useQuery({
    ...assistantsOauthConnectionsListOptions({
      path: { assistant_id: platformAssistantId ?? "" },
    }),
    enabled: Boolean(platformAssistantId) && platformGate === "full",
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

  const oauthUnavailable =
    providers.isError ||
    connections.isError ||
    Boolean(platformAssistantIdError) ||
    (!assistantLoading && !assistant);
  const oauthReady =
    !oauthUnavailable &&
    Boolean(providers.data) &&
    (platformGate !== "full" || Boolean(connections.data));
  const allItems = useMemo(
    () =>
      buildIntegrationItems(
        oauthReady ? (providers.data ?? []) : [],
        oauthReady ? (connections.data ?? []) : [],
        mcp.list.data?.servers ?? [],
      ),
    [oauthReady, providers.data, connections.data, mcp.list.data],
  );
  const items = useMemo(
    () => filterIntegrationItems(allItems, searchText),
    [allItems, searchText],
  );
  const configuredItems = items.filter((item) => item.configured);
  const availableItems = items.filter((item) => !item.configured);
  const selectedProvider = providers.data?.find(
    (provider) => provider.provider_key === selectedProviderKey,
  );
  const loading =
    assistantLoading ||
    providers.isLoading ||
    connections.isLoading ||
    platformAssistantIdLoading ||
    mcp.list.isLoading;
  const authBusy = mcp.auth.isBusy;

  const addCustom = () => {
    if (allowAdd) {
      mcp.setAddOpen(true);
    } else {
      navigateToNewConversation(navigate, { prompt: t("mcpPage.setupPrompt") });
    }
  };

  const renderItem = (item: IntegrationItem) => {
    if (item.kind === "oauth") {
      return (
        <IntegrationRow
          key={item.id}
          layout={item.configured ? "row" : "tile"}
          providerKey={item.provider.provider_key}
          displayName={item.name}
          description={item.provider.description}
          logoUrl={item.provider.logo_url}
          connections={item.connections}
          disabled={
            assistantLoading ||
            !assistant ||
            (platformGate === "full" && !platformAssistantId)
          }
          onConfigure={() =>
            setSelectedProviderKey(item.provider.provider_key)
          }
        />
      );
    }
    return (
      <McpServerCard
        key={item.id}
        server={item.server}
        onRemove={mcp.setRemoveServerId}
        onConfigure={mcp.setConfigureServerId}
        onAuthenticate={(serverId) => mcp.auth.connect(serverId)}
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
        connectDisabled={authBusy}
      />
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={searchText}
          onChange={(event) => setSearchText(event.target.value)}
          placeholder={t("integrationsPage.searchPlaceholder")}
          aria-label={t("integrationsPage.searchAriaLabel")}
          leftIcon={<Search aria-hidden className="size-4" />}
          className="min-h-11"
          wrapperClassName="min-w-0 basis-64 flex-1"
          fullWidth
        />
        <Button
          variant="outlined"
          className="min-h-11 max-w-full whitespace-normal"
          leftIcon={<Plus />}
          onClick={addCustom}
          disabled={!flagsHydrated || authBusy}
        >
          {t("integrationsPage.addCustom")}
        </Button>
      </div>

      {oauthUnavailable ? (
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

      {configuredItems.length > 0 ? (
        <IntegrationSection
          title={t("integrationsPage.sectionConfigured")}
          count={configuredItems.length}
          gridClassName={CONFIGURED_GRID}
        >
          {configuredItems.map(renderItem)}
        </IntegrationSection>
      ) : null}
      {availableItems.length > 0 ? (
        <IntegrationSection
          title={t("integrationsPage.sectionAvailable")}
          count={availableItems.length}
          gridClassName={AVAILABLE_GRID}
        >
          {availableItems.map(renderItem)}
        </IntegrationSection>
      ) : null}
      {!loading && items.length === 0 ? (
        <p className="py-8 text-center text-body-medium-default text-[var(--content-tertiary)]">
          {searchText.trim()
            ? t("integrationsPage.emptySearchSubtitle", {
                query: searchText.trim(),
              })
            : t("integrationsPage.empty")}
        </p>
      ) : null}

      {selectedProvider &&
      assistant &&
      (platformGate !== "full" || platformAssistantId) ? (
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
          tenantHost={selectedProvider.tenant_host}
          onClose={closeProvider}
        />
      ) : null}
    </div>
  );
}

export function IntegrationsPage() {
  const mcpAssistantId = useActiveAssistantId();
  return (
    <Suspense>
      <IntegrationsPanelInner
        key={mcpAssistantId}
        mcpAssistantId={mcpAssistantId}
      />
    </Suspense>
  );
}
