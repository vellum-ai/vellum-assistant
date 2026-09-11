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
  return (
    <>
      {auth.attempt ? (
        <Notice tone={auth.attempt.error ? "warning" : "info"}>
          <div className="space-y-2">
            <p className="[overflow-wrap:anywhere]">
              {auth.attempt.error ??
                (auth.attempt.phase === "connecting"
                  ? t("mcpConnect.waitingForRuntime", {
                      name: auth.attempt.serverId,
                    })
                  : t("mcpConnect.waitingForAuthorization", {
                      name: auth.attempt.serverId,
                    }))}
            </p>
            <div className="flex flex-wrap gap-2">
              {auth.attempt.phase === "error" ? (
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
        toolsSummary={details.data?.servers.find(
          (entry) => entry.serverId === configureServer?.id,
        )}
        toolsLoading={details.isPending}
        toolsError={details.isError}
        onClose={() => connections.setConfigureServerId(null)}
        onSave={(_serverId, updates) => save.mutate(updates)}
        isPending={save.isPending}
      />
      <ConfirmDialog
        open={connections.removeServerId !== null}
        title={t("mcpPage.removeDialogTitle")}
        message={
          connections.removeServerId
            ? t("mcpPage.removeDialogMessage", {
                serverId: connections.removeServerId,
              })
            : ""
        }
        confirmLabel={t("mcpPage.removeDialogConfirm")}
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
