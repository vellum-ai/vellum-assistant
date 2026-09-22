import { useQuery } from "@tanstack/react-query";
import { Button } from "@vellumai/design-library/components/button";
import { FilterChip } from "@vellumai/design-library/components/filter-chip";
import { Input } from "@vellumai/design-library/components/input";
import { Notice } from "@vellumai/design-library/components/notice";
import {
  INTEGRATION_CATEGORIES,
  type IntegrationCategory,
} from "@vellumai/service-contracts/integration-categories";
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
import { useLocation, useNavigate, useSearchParams } from "react-router";

import { type Assistant, getAssistant } from "@/assistant/api";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { assistantsOauthConnectionsListOptions } from "@/generated/api/@tanstack/react-query.gen";
import { oauthProvidersGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import { useOnboardingLogin } from "@/hooks/use-onboarding-login";
import { usePlatformAssistantId } from "@/hooks/use-platform-assistant-id";
import {
  useActiveAssistantIsPlatformHosted,
  usePlatformGate,
} from "@/hooks/use-platform-gate";
import { usePluginsList } from "@/hooks/use-plugins-list";
import { useTenantHostRequirement } from "@/hooks/use-tenant-host-requirement";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { openExternalUrl } from "@/runtime/browser";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { navigateToNewConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

import { IntegrationConnectModal } from "../components/integration-connect-modal";
import { IntegrationRow } from "../components/integration-row";
import { IntegrationTile } from "../components/integration-tile";
import { ManagedConnectController } from "../components/managed-connect-controller";
import { YourOwnTab } from "../components/your-own-oauth-tab";
import {
  buildConnectPlan,
  planConnections,
  type ConnectPlan,
} from "../connect-plan";
import { useIntegrationConnect } from "../hooks/use-integration-connect";
import { useIntegrationDisconnect } from "../hooks/use-integration-disconnect";
import {
  buildIntegrationItems,
  filterIntegrationItems,
  type IntegrationItem,
} from "../integration-items";
import { McpConnectionDialogs } from "../mcp/mcp-connection-dialogs";
import { buildMcpPluginDefinitions } from "../mcp/mcp-plugin-definitions";
import { McpServerCard } from "../mcp/mcp-server-card";
import { provisionalPluginServerId } from "../mcp/plugin-mcp-connect";
import { PluginIntegrationRow } from "../mcp/plugin-integration-row";
import { useMcpConnections } from "../mcp/use-mcp-connections";

type SettingsTranslate = ReturnType<typeof useTranslation<"settings">>["t"];

/** One literal key per category, so the catalog check can see each is read. */
const CATEGORY_LABEL_KEYS = {
  productivity: "integrationsPage.categories.productivity",
  communication: "integrationsPage.categories.communication",
  meetings: "integrationsPage.categories.meetings",
  sales: "integrationsPage.categories.sales",
  marketing: "integrationsPage.categories.marketing",
  finance: "integrationsPage.categories.finance",
  commerce: "integrationsPage.categories.commerce",
  engineering: "integrationsPage.categories.engineering",
  knowledge: "integrationsPage.categories.knowledge",
  recruiting: "integrationsPage.categories.recruiting",
} as const satisfies Record<IntegrationCategory, string>;

/** Connected integrations, wide enough for a row's status and its actions. */
export const CONFIGURED_GRID =
  "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,22rem),1fr))]";
/** Everything still to connect, at the tile width the catalog is browsed in. */
export const AVAILABLE_GRID =
  "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]";

export function IntegrationSection({
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
  const location = useLocation();
  const platformGate = usePlatformGate();
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const allowAdd = useAssistantFeatureFlagStore.use.mcpAddServer();
  const flagsHydrated = useAssistantFeatureFlagStore.use.hasHydrated();
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [assistantLoading, setAssistantLoading] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [category, setCategory] = useState<IntegrationCategory | null>(null);
  const providerParam = searchParams.get("provider");
  const handledProviderParam = useRef<string | null>(null);
  const mcp = useMcpConnections(mcpAssistantId);
  const plugins = usePluginsList(mcpAssistantId);
  const connect = useIntegrationConnect({ assistantId: mcpAssistantId, mcp });

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

  // The same login PlatformLoginNotice offers, returning to this page with
  // its query intact so a deep-linked provider survives the round trip.
  const { login } = useOnboardingLogin(
    `${location.pathname}${location.search}${location.hash}`,
  );
  const startLogin = useCallback(() => void login(), [login]);

  const dismissConnectModal = connect.closeModal;
  const cancelAttempt = connect.cancel;
  const connectingItemId = connect.attemptItemId;
  const modalItemId = connect.modal?.itemId ?? null;
  const setToolsServerId = mcp.setToolsServerId;
  const closeConnectModal = useCallback(() => {
    // Closing the dialog abandons the sign-in it was reporting. For a
    // connected integration the dialog is the only surface that draws one, so
    // leaving it running would hold every other connect action against a wait
    // with nothing to show it or stop it.
    if (modalItemId !== null && connectingItemId === modalItemId) {
      cancelAttempt();
    }
    dismissConnectModal();
    setToolsServerId(null);
    if (!searchParams.has("provider")) {
      return;
    }
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete("provider");
    setSearchParams(nextSearchParams, { replace: true });
  }, [
    cancelAttempt,
    connectingItemId,
    dismissConnectModal,
    modalItemId,
    searchParams,
    setSearchParams,
    setToolsServerId,
  ]);

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
        !plugins.installedLoaded
          ? []
          : buildMcpPluginDefinitions(
              plugins.catalogMatches,
              plugins.installedPlugins,
            ),
        mcp.list.isSuccess,
      ),
    [
      oauthReady,
      providers.data,
      connections.data,
      mcp.list.data,
      mcp.list.isSuccess,
      plugins.installedLoaded,
      plugins.catalogMatches,
      plugins.installedPlugins,
    ],
  );
  // One chip per category the catalog files something under, in the
  // catalog's order and with the whole count, so the row is the same whatever
  // the search box says and a chip reads as a place rather than a result.
  const categories = useMemo(() => {
    const counts = new Map<IntegrationCategory, number>();
    for (const item of allItems) {
      if (item.category) {
        counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
      }
    }
    return INTEGRATION_CATEGORIES.flatMap((entry) => {
      const count = counts.get(entry);
      return count ? [{ category: entry, count }] : [];
    });
  }, [allItems]);
  // A chip the catalog no longer offers, after a reload, drops out of the
  // filter rather than emptying the page.
  const activeCategory = categories.some(
    (entry) => entry.category === category,
  )
    ? category
    : null;
  const items = useMemo(
    () => filterIntegrationItems(allItems, searchText, activeCategory),
    [allItems, searchText, activeCategory],
  );
  // Every way each integration connects, connected or not: the same plan
  // drives the tile that offers a first connection and the dialog that
  // manages the ones an integration already has.
  const plans = useMemo(() => {
    const byItemId = new Map<string, ConnectPlan>();
    for (const item of allItems) {
      if (item.kind === "mcp") {
        continue;
      }
      const plan = buildConnectPlan(item, {
        platformGate,
        ownOAuthAvailable: !isPlatformHosted,
        mcpServersLoaded: mcp.list.isSuccess,
      });
      if (plan) {
        byItemId.set(item.id, plan);
      }
    }
    return byItemId;
  }, [allItems, isPlatformHosted, mcp.list.isSuccess, platformGate]);
  // A tile is for what is still to connect, plus whatever is being connected
  // right now with no dialog of its own to report it: a plugin counts as
  // configured the moment it installs, and an integration must not change
  // section while the user is watching its sign-in. An integration that is
  // already connected keeps its place, because the dialog the user opened it
  // from is the surface drawing that attempt.
  const showsTile = (item: IntegrationItem) =>
    plans.has(item.id) &&
    (!item.configured ||
      (item.id === connectingItemId && connect.modal?.itemId !== item.id));
  const isAvailable = (item: IntegrationItem) =>
    !item.configured || showsTile(item);
  const configuredItems = items.filter((item) => !isAvailable(item));
  // Alphabetical, and nothing else. The shared sort puts what is configured
  // first, which would jump the tile being connected to the head of the grid
  // the moment its plugin installs.
  const availableItems = items
    .filter(isAvailable)
    .sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
  const loading =
    assistantLoading ||
    providers.isLoading ||
    connections.isLoading ||
    platformAssistantIdLoading ||
    mcp.list.isLoading ||
    ((plugins.isLoading || plugins.catalogLoading) && allItems.length === 0);
  // One attempt at a time, on every surface: a managed authorization is just
  // as exclusive as an MCP one, and the rows and cards that predate the tiles
  // only knew about the MCP machine.
  const authBusy = mcp.auth.isBusy || connect.managed !== null;
  const oauthDisabled =
    assistantLoading ||
    !assistant ||
    (platformGate === "full" && !platformAssistantId);
  // The attempt is drawn inside the tile, or in the connect modal over it,
  // only while that surface is on screen. A search that filters the owning
  // integration out leaves the page-level notice as the one place with a
  // progress line and a way to stop.
  const inlineAttemptShown =
    connect.ownsMcpAttempt &&
    connectingItemId !== null &&
    (connect.modal?.itemId === connectingItemId ||
      items.some((item) => item.id === connectingItemId && showsTile(item)));
  const connectModalItem = connect.modal
    ? allItems.find((item) => item.id === connect.modal?.itemId)
    : undefined;
  const connectModalPlan = connectModalItem
    ? plans.get(connectModalItem.id)
    : undefined;
  const connectModalProvider =
    connectModalItem?.kind === "oauth" ? connectModalItem.provider : undefined;
  const connectModalTenantHost = useTenantHostRequirement(
    connectModalProvider?.provider_key ?? "",
    connectModalProvider?.tenant_host,
  );

  // A deep link names a provider, not an item, and the catalog it belongs to
  // arrives after the page mounts. The link is answered once the item it names
  // exists, and again only when the query changes.
  const openConnectModal = connect.openModal;
  useEffect(() => {
    if (!providerParam) {
      handledProviderParam.current = null;
      return;
    }
    if (providerParam === handledProviderParam.current) {
      return;
    }
    const target = allItems.find(
      (item) =>
        item.kind === "oauth" && item.provider.provider_key === providerParam,
    );
    if (!target) {
      return;
    }
    handledProviderParam.current = providerParam;
    openConnectModal(target.id);
  }, [allItems, openConnectModal, providerParam]);

  // The tools summary covers every server at once, so the dialog asks for one
  // server and the row it belongs to is found in the plan on screen.
  const toolsServerId = mcp.toolsServerId;
  const toolsServer = mcp.list.data?.servers.find(
    (entry) => entry.id === toolsServerId,
  );
  const toolsConnection =
    connectModalPlan && toolsServerId
      ? planConnections(connectModalPlan).find(
          (candidate) => candidate.serverId === toolsServerId,
        )
      : undefined;
  const toolsByConnectionId = toolsConnection
    ? {
        [toolsConnection.id]: {
          loading: mcp.details.isFetching,
          error: mcp.details.isError,
          summary: mcp.details.data?.servers.find(
            (entry) => entry.serverId === toolsServerId,
          ),
          endpointUrl: toolsServer?.transport.url,
        },
      }
    : undefined;

  const disconnectIntegration = useIntegrationDisconnect({
    assistantId: mcpAssistantId,
    platformAssistantId,
    onStopAuth: (connection) => {
      const waitingOn = mcp.auth.attempt?.serverId;
      if (!waitingOn) {
        return;
      }
      // An uninstall takes every server the plugin declared, so a sign-in
      // waiting on a sibling is stranded by it just as surely as one waiting
      // on the row that was clicked. The provisional id an attempt carries
      // while its plugin installs belongs to the plugin too.
      const strandedByPlugin =
        connection.pluginName !== undefined &&
        (waitingOn === provisionalPluginServerId(connection.pluginName) ||
          mcp.list.data?.servers.find((entry) => entry.id === waitingOn)
            ?.pluginName === connection.pluginName);
      if (waitingOn === connection.serverId || strandedByPlugin) {
        mcp.auth.stopWaiting();
      }
    },
    onRemoveServer: mcp.setRemoveServerId,
    onPluginRemoved: () => void mcp.list.refetch(),
  });

  const addCustom = () => {
    if (allowAdd) {
      mcp.setAddOpen(true);
    } else {
      navigateToNewConversation(navigate, { prompt: t("mcpPage.setupPrompt") });
    }
  };

  const renderItem = (item: IntegrationItem) => {
    const plan = item.kind === "mcp" ? undefined : plans.get(item.id);
    if (item.kind !== "mcp" && plan && showsTile(item)) {
      return (
        <IntegrationTile
          key={item.id}
          plan={plan}
          state={connect.stateFor(item.id, plan.name)}
          // The choice between the provider's own server, Vellum's hosted
          // sign-in, and your own OAuth app is only a real one on a
          // self-hosted assistant.
          showAlternatives={!isPlatformHosted}
          disabled={
            connect.isBusyElsewhere(item.id) ||
            (plan.primary.kind === "managed-oauth" && oauthDisabled)
          }
          onConnect={(method) => connect.start(item, plan, method)}
          onLogin={startLogin}
          onCancel={connect.cancel}
          onRetry={connect.retry}
          onOpenSetupGuide={(url) => void openExternalUrl(url)}
        />
      );
    }
    if (item.kind === "oauth") {
      return (
        <IntegrationRow
          key={item.id}
          providerKey={item.provider.provider_key}
          displayName={item.name}
          description={item.provider.description}
          logoUrl={item.provider.logo_url}
          connections={item.connections}
          mcpMethods={item.methods}
          disabled={
            oauthDisabled || !plan || connect.isBusyElsewhere(item.id)
          }
          onConfigure={() => connect.openModal(item.id)}
        />
      );
    }
    if (item.kind === "plugin") {
      return (
        <PluginIntegrationRow
          key={item.id}
          assistantId={mcpAssistantId}
          method={item.method}
          disabled={!plan || connect.isBusyElsewhere(item.id)}
          onOpen={() => connect.openModal(item.id)}
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
      <div className="space-y-3">
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
        {categories.length > 0 ? (
          <div
            role="group"
            aria-label={t("integrationsPage.categoriesLabel")}
            className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]"
          >
            {categories.map((entry) => (
              <FilterChip
                key={entry.category}
                selected={activeCategory === entry.category}
                count={entry.count}
                onClick={() =>
                  setCategory(
                    activeCategory === entry.category ? null : entry.category,
                  )
                }
              >
                {t(CATEGORY_LABEL_KEYS[entry.category])}
              </FilterChip>
            ))}
          </div>
        ) : null}
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
      {plugins.catalogError || plugins.isError ? (
        <Notice tone="warning">
          {t("integrationsPage.pluginCatalogUnavailable")}
        </Notice>
      ) : null}
      <McpConnectionDialogs
        connections={mcp}
        allowAdd={allowAdd}
        attemptReportedElsewhere={inlineAttemptShown}
      />
      {connect.managed && assistant ? (
        <ManagedConnectController
          key={connect.managed.providerKey}
          assistantId={assistant.id}
          providerKey={connect.managed.providerKey}
          providerLabel={connect.managed.providerLabel}
          tenantHost={connect.managed.tenantHost}
          restartToken={connect.managed.restartToken}
          onReport={connect.onManagedReport}
        />
      ) : null}

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
            : activeCategory
              ? t("integrationsPage.emptyCategory", {
                  category: t(CATEGORY_LABEL_KEYS[activeCategory]),
                })
              : t("integrationsPage.empty")}
        </p>
      ) : null}

      {connect.modal &&
      connectModalPlan &&
      connectModalItem &&
      connectModalItem.kind !== "mcp" ? (
        <IntegrationConnectModal
          key={connectModalItem.id}
          plan={connectModalPlan}
          focusMethodId={connect.modal.methodId}
          attempt={connect.attemptFor(connectModalItem.id)}
          tenantHost={connectModalTenantHost}
          toolsByConnectionId={toolsByConnectionId}
          ownOAuthContent={
            assistant && connectModalItem.kind === "oauth" ? (
              <YourOwnTab
                assistantId={assistant.id}
                providerKey={connectModalItem.provider.provider_key}
                displayName={connectModalItem.name}
                logoUrl={connectModalItem.provider.logo_url}
              />
            ) : null
          }
          onConnect={(method, options) =>
            connect.run(connectModalItem, connectModalPlan, method, options)
          }
          onLogin={startLogin}
          onCancelAttempt={connect.cancel}
          onRetryAttempt={connect.retry}
          onReconnect={(connection) =>
            connect.reconnect(connectModalItem, connectModalPlan, connection)
          }
          onOpenTools={(connection) =>
            mcp.setToolsServerId(connection.serverId ?? null)
          }
          onDisconnect={(connection) =>
            disconnectIntegration(connection, connectModalPlan.name)
          }
          onOpenSetupGuide={(url) => void openExternalUrl(url)}
          onClose={closeConnectModal}
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
