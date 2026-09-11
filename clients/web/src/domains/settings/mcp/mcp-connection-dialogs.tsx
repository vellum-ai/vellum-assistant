import { Button } from "@vellumai/design-library/components/button";
import { ConfirmDialog } from "@vellumai/design-library/components/confirm-dialog";
import { Notice } from "@vellumai/design-library/components/notice";

import { useTranslation } from "@/i18n";

import { McpAddServerModal } from "./mcp-add-server-modal";
import { McpServerDetailModal } from "./mcp-server-detail-modal";
import type { useMcpConnections } from "./use-mcp-connections";

export function McpConnectionDialogs({
  connections,
  allowAdd,
}: {
  connections: ReturnType<typeof useMcpConnections>;
  allowAdd: boolean;
}) {
  const { t } = useTranslation("settings");
  const { auth, add, save, remove, details, configureServer } = connections;
  const removingCatalog = Boolean(
    connections.list.data?.servers.find(
      (server) => server.id === connections.removeServerId,
    )?.catalog,
  );
  return (
    <>
      {auth.attempt ? (
        <Notice tone={auth.attempt.error ? "warning" : "info"}>
          <div className="space-y-2">
            {auth.attempt.error ? (
              <p className="font-medium [overflow-wrap:anywhere]">
                {auth.attempt.displayName}
              </p>
            ) : null}
            <p className="[overflow-wrap:anywhere]">
              {auth.attempt.error ??
                (auth.attempt.phase === "connecting"
                  ? t("mcpConnect.waitingForRuntime", {
                      name: auth.attempt.displayName,
                    })
                  : t(
                      auth.attempt.phase === "waiting"
                        ? "mcpConnect.authorizationWindowClosed"
                        : "mcpConnect.waitingForAuthorization",
                      { name: auth.attempt.displayName },
                    ))}
            </p>
            <div className="flex flex-wrap gap-2">
              {auth.attempt.phase === "error" ||
              auth.attempt.phase === "waiting" ? (
                <Button
                  variant="outlined"
                  onClick={auth.retry}
                  disabled={auth.isCancelling}
                >
                  {t("mcpConnect.retry")}
                </Button>
              ) : null}
              <Button
                variant="ghost"
                onClick={() => void auth.dismiss()}
                disabled={auth.isCancelling}
              >
                {auth.canCancel
                  ? t("mcpConnect.cancel")
                  : t("mcpConnect.stopWaiting")}
              </Button>
            </div>
          </div>
        </Notice>
      ) : null}
      {allowAdd ? (
        <McpAddServerModal
          open={connections.addOpen}
          onClose={() => connections.setAddOpen(false)}
          onAdd={connections.addCustom}
          isPending={add.isPending}
        />
      ) : null}
      <McpServerDetailModal
        server={configureServer}
        displayName={
          configureServer
            ? connections.serverDisplayName(configureServer.id)
            : undefined
        }
        toolsSummary={details.data?.servers.find(
          (entry) => entry.serverId === configureServer?.id,
        )}
        toolsLoading={details.isPending || details.isFetching}
        toolsError={details.isError}
        toolLimits={details.data?.limits}
        onClose={() => connections.setConfigureServerId(null)}
        onSave={(_serverId, updates) => save.mutate(updates)}
        isPending={save.isPending}
      />
      <ConfirmDialog
        open={connections.removeServerId !== null}
        title={t(
          removingCatalog
            ? "mcpCatalog.disconnectTitle"
            : "mcpPage.removeDialogTitle",
        )}
        message={
          connections.removeServerId
            ? t(
                removingCatalog
                  ? "mcpCatalog.disconnectMessage"
                  : "mcpPage.removeDialogMessage",
                {
                  serverId: connections.serverInstanceDisplayName(
                    connections.removeServerId,
                  ),
                },
              )
            : ""
        }
        confirmLabel={t(
          removingCatalog
            ? "mcpServerCard.disconnect"
            : "mcpPage.removeDialogConfirm",
        )}
        destructive
        isPending={remove.isPending}
        onConfirm={() => {
          if (connections.removeServerId) {
            remove.mutate(connections.removeServerId);
          }
        }}
        onCancel={() => connections.setRemoveServerId(null)}
      />
    </>
  );
}
