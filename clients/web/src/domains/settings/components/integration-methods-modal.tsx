import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Modal } from "@vellumai/design-library/components/modal";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag } from "@vellumai/design-library/components/tag";

import { usePluginActions } from "@/hooks/use-plugin-actions";
import { useTranslation } from "@/i18n";
import { openExternalUrl } from "@/runtime/browser";
import { IntegrationIcon } from "@/components/integrations/integration-icon";

import {
  type IntegrationItem,
  isMcpPluginMethodConfigured,
  type McpPluginMethod,
} from "../integration-items";
import type { McpServerEntry } from "../mcp/mcp-api";
import { McpIntegrationIcon } from "../mcp/mcp-integration-icon";
import { PluginIntegrationIcon } from "../mcp/plugin-integration-icon";
import type { useMcpConnections } from "../mcp/use-mcp-connections";
import { IntegrationListRow } from "./integration-list-row";
import { IntegrationRow } from "./integration-row";

function PluginServerRow({
  server,
  method,
  connections,
}: {
  server: McpServerEntry;
  method: McpPluginMethod;
  connections: ReturnType<typeof useMcpConnections>;
}) {
  const { t } = useTranslation("settings");
  const authError =
    connections.auth.attempt?.serverId === server.id
      ? connections.auth.attempt.error
      : undefined;
  const authenticating =
    connections.auth.isBusy &&
    connections.auth.attempt?.serverId === server.id;
  const connected = server.status === "connected";
  const canAuthenticate =
    !connected && server.transport.type !== "stdio";

  return (
    <div className="space-y-2">
      <IntegrationListRow
        icon={<McpIntegrationIcon />}
        title={server.id}
        subtitle={
          server.transport.type === "stdio"
            ? t("pluginIntegration.localServer")
            : t("pluginIntegration.remoteServer")
        }
        status={
          <Tag tone={connected ? "positive" : "negative"}>
            {connected
              ? t("integrationRow.connected")
              : t("integrationRow.needsAttention")}
          </Tag>
        }
        primaryAction={
          <Button
            variant={canAuthenticate ? "primary" : "outlined"}
            leftIcon={
              authenticating ? <Loader2 className="animate-spin" /> : undefined
            }
            disabled={
              authenticating ||
              (canAuthenticate && connections.auth.isBusy)
            }
            onClick={() => {
              if (canAuthenticate) {
                connections.auth.connect(
                  server.id,
                  undefined,
                  method.definition.displayName,
                );
              } else {
                connections.setConfigureServerId(server.id);
              }
            }}
          >
            {authenticating
              ? t("mcpServerCard.connecting")
              : canAuthenticate
                ? server.status === "error"
                  ? t("mcpConnect.retry")
                  : t("integrationRow.connect")
                : t("mcpServerCard.viewDetails")}
          </Button>
        }
      />
      {authError ? <Notice tone="warning">{authError}</Notice> : null}
    </div>
  );
}

function PluginMethodSection({
  assistantId,
  method,
  connections,
  refreshing,
  loadError,
  installedOverride,
  icon,
  onRetryServers,
  onInstalled,
  onRemoved,
}: {
  assistantId: string;
  method: McpPluginMethod;
  connections: ReturnType<typeof useMcpConnections>;
  refreshing: boolean;
  loadError: boolean;
  installedOverride: boolean;
  icon?: ReactNode;
  onRetryServers: () => void;
  onInstalled: (method: McpPluginMethod) => void;
  onRemoved: () => void;
}) {
  const { t } = useTranslation("settings");
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const installed = installedOverride || isMcpPluginMethodConfigured(method);
  const actions = usePluginActions(assistantId, method.definition.pluginName, {
    onInstalled: () => onInstalled(method),
    onRemoved,
  });

  return (
    <section className="space-y-3">
      <div className="flex items-start gap-3">
        {icon ?? (
          <PluginIntegrationIcon
            assistantId={assistantId}
            definition={method.definition}
          />
        )}
        <div className="min-w-0 space-y-1">
          <h3 className="text-title-small text-[var(--content-default)]">
            {method.definition.displayName}
          </h3>
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            {method.definition.description}
          </p>
        </div>
      </div>

      <p className="text-body-medium-default [overflow-wrap:anywhere]">
        {method.definition.setup.instructions}
      </p>
      <Button
        variant="outlined"
        onClick={() => void openExternalUrl(method.definition.documentationUrl)}
      >
        {t("pluginIntegration.openDocumentation")}
      </Button>

      {actions.isInstallError || actions.isRemoveError ? (
        <Notice tone="warning">{t("pluginIntegration.actionFailed")}</Notice>
      ) : null}

      {installed ? (
        <div className="space-y-2">
          {method.servers.map((server) => (
            <PluginServerRow
              key={server.id}
              server={server}
              method={method}
              connections={connections}
            />
          ))}
          {method.servers.length === 0 ? (
            loadError ? (
              <Notice
                tone="warning"
                actions={
                  <Button variant="ghost" onClick={onRetryServers}>
                    {t("mcpConnect.retry")}
                  </Button>
                }
              >
                {t("pluginIntegration.serverLoadFailed")}
              </Notice>
            ) : (
              <Notice tone="warning">
                {refreshing
                  ? t("pluginIntegration.findingServers")
                  : t("pluginIntegration.noServers")}
              </Notice>
            )
          ) : null}
          <Button
            variant="dangerGhost"
            leftIcon={<Trash2 />}
            disabled={actions.isRemoving}
            onClick={() => setConfirmingRemove(true)}
          >
            {t("pluginIntegration.removePlugin")}
          </Button>
        </div>
      ) : (
        <Button
          disabled={actions.isInstalling || refreshing}
          leftIcon={
            actions.isInstalling ? (
              <Loader2 className="animate-spin" />
            ) : undefined
          }
          onClick={actions.install}
        >
          {actions.isInstalling
            ? t("pluginIntegration.installing")
            : t("pluginIntegration.install")}
        </Button>
      )}

      <ConfirmDialog
        open={confirmingRemove}
        title={t("pluginIntegration.removeTitle", {
          name: method.definition.displayName,
        })}
        message={t("pluginIntegration.removeMessage", {
          name: method.definition.displayName,
          count: method.servers.length,
        })}
        confirmLabel={t("pluginIntegration.removePlugin")}
        destructive
        isPending={actions.isRemoving}
        onConfirm={() => {
          if (
            method.servers.some(
              (server) => server.id === connections.auth.attempt?.serverId,
            )
          ) {
            connections.auth.stopWaiting();
          }
          actions.remove();
        }}
        onCancel={() => setConfirmingRemove(false)}
      />
    </section>
  );
}

export function IntegrationMethodsModal({
  assistantId,
  item,
  connections,
  oauthDisabled,
  onOAuth,
  onClose,
}: {
  assistantId: string;
  item: Extract<IntegrationItem, { kind: "oauth" | "plugin" }>;
  connections: ReturnType<typeof useMcpConnections>;
  oauthDisabled: boolean;
  onOAuth: (providerKey: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const [refreshingPlugin, setRefreshingPlugin] = useState<string | null>(null);
  const [serverLoadFailed, setServerLoadFailed] = useState<string | null>(null);
  const [locallyInstalledPlugins, setLocallyInstalledPlugins] = useState(
    () => new Set<string>(),
  );
  const mounted = useRef(true);
  const refreshOperation = useRef(0);
  const methods = item.kind === "oauth" ? item.methods : [item.method];

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshOperation.current += 1;
    };
  }, []);

  const handleInstalled = async (method: McpPluginMethod) => {
    if (!mounted.current) {
      return;
    }
    setLocallyInstalledPlugins((current) => {
      const next = new Set(current);
      next.add(method.definition.pluginName);
      return next;
    });
    const operation = ++refreshOperation.current;
    setRefreshingPlugin(method.definition.pluginName);
    setServerLoadFailed(null);
    const result = await connections.list.refetch();
    if (!mounted.current || operation !== refreshOperation.current) {
      return;
    }
    setRefreshingPlugin(null);
    if (result.isError) {
      setServerLoadFailed(method.definition.pluginName);
      return;
    }
  };

  const handleRemoved = () => {
    if (!mounted.current) {
      return;
    }
    void connections.list.refetch();
    onClose();
  };

  return (
    <Modal.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <Modal.Content size="lg">
        <Modal.Header>
          <Modal.Title className="[&>span]:whitespace-normal">
            {item.name}
          </Modal.Title>
          <Modal.Description>
            {item.kind === "oauth"
              ? t("pluginIntegration.chooseMethod")
              : item.description}
          </Modal.Description>
        </Modal.Header>
        <Modal.Body className="space-y-5">
          {item.kind === "oauth" ? (
            <IntegrationRow
              providerKey={item.provider.provider_key}
              displayName={t("pluginIntegration.providerAccount", {
                name: item.name,
              })}
              description={item.provider.description}
              logoUrl={item.provider.logo_url}
              connections={item.connections}
              disabled={oauthDisabled}
              onConfigure={() => onOAuth(item.provider.provider_key)}
            />
          ) : null}

          {methods.map((method) => (
            <PluginMethodSection
              key={method.definition.pluginName}
              assistantId={assistantId}
              method={method}
              connections={connections}
              refreshing={
                refreshingPlugin === method.definition.pluginName ||
                connections.list.isFetching
              }
              loadError={
                serverLoadFailed === method.definition.pluginName ||
                connections.list.isError
              }
              installedOverride={locallyInstalledPlugins.has(
                method.definition.pluginName,
              )}
              icon={
                item.kind === "oauth" ? (
                  <IntegrationIcon
                    providerKey={item.provider.provider_key}
                    displayName={item.name}
                    logoUrl={item.provider.logo_url}
                    size={32}
                  />
                ) : undefined
              }
              onRetryServers={() => void handleInstalled(method)}
              onInstalled={handleInstalled}
              onRemoved={handleRemoved}
            />
          ))}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" onClick={onClose}>
            {t("integrationDetailModal.close")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
