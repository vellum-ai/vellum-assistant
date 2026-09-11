import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";

import { useTranslation } from "@/i18n";

import {
  catalogDefinitionKey,
  type IntegrationItem,
} from "../integration-items";
import type { McpCatalogEntry } from "../mcp/mcp-catalog-api";
import { McpServerCard } from "../mcp/mcp-server-card";
import type { useMcpConnections } from "../mcp/use-mcp-connections";
import { IntegrationRow } from "./integration-row";

export function IntegrationMethodsModal({
  item,
  mcp,
  oauthDisabled,
  onOAuth,
  onCatalog,
  onClose,
}: {
  item: Exclude<IntegrationItem, { kind: "mcp" }>;
  mcp: ReturnType<typeof useMcpConnections>;
  oauthDisabled: boolean;
  onOAuth: (providerKey: string) => void;
  onCatalog: (entry: McpCatalogEntry) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const methods = item.kind === "oauth" ? item.methods : [item.method];
  const busy = mcp.auth.isBusy;
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
          <Modal.Description>{t("mcpCatalog.chooseMethod")}</Modal.Description>
        </Modal.Header>
        <Modal.Body className="space-y-5">
          {item.kind === "oauth" ? (
            <IntegrationRow
              providerKey={item.provider.provider_key}
              displayName={t("mcpCatalog.oauthMethod")}
              description={t("mcpCatalog.oauthMethodDescription")}
              logoUrl={item.provider.logo_url}
              connections={item.connections}
              disabled={oauthDisabled}
              onConfigure={() => {
                onClose();
                onOAuth(item.provider.provider_key);
              }}
            />
          ) : null}
          {methods.map((method) => (
            <section
              className="space-y-2"
              key={catalogDefinitionKey(method.definition)}
            >
              <h3 className="text-body-medium-default">
                {t("mcpCatalog.mcpMethod", {
                  name: method.definition.displayName,
                })}
              </h3>
              <p className="text-body-small-default text-[var(--content-tertiary)]">
                {method.definition.description}
              </p>
              {method.servers.map((server) => (
                <McpServerCard
                  key={server.id}
                  server={server}
                  displayName={method.definition.displayName}
                  providerKey={method.definition.icon}
                  isAuthenticating={
                    busy && mcp.auth.attempt?.serverId === server.id
                  }
                  connectDisabled={busy}
                  onConfigure={(serverId) => {
                    onClose();
                    mcp.setConfigureServerId(serverId);
                  }}
                  onAuthenticate={(serverId) => {
                    onClose();
                    mcp.connectServer(serverId);
                  }}
                  onRemove={mcp.setRemoveServerId}
                />
              ))}
              {method.servers.length === 0 ? (
                <Button
                  className="min-h-11"
                  disabled={busy || !mcp.catalog.data?.supportsConnect}
                  onClick={() => {
                    onClose();
                    onCatalog(method.definition);
                  }}
                >
                  {method.definition.setup.mode === "manual"
                    ? t("mcpCatalog.setUp")
                    : t("integrationRow.connect")}
                </Button>
              ) : null}
            </section>
          ))}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outlined" className="min-h-11" onClick={onClose}>
            {t("integrationDetailModal.confirm")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
