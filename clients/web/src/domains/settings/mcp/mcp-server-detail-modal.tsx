import { Cable } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { McpServerEntry, McpToolsSummaryServer } from "./mcp-api";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";

import { useTranslation } from "@/i18n";

type AuthType = "none" | "bearer" | "api-key";

type SettingsTranslate = ReturnType<
  typeof useTranslation<"settings">
>["t"];

const AUTH_OPTION_VALUES: AuthType[] = ["none", "bearer", "api-key"];

function authOptionLabel(authType: AuthType, t: SettingsTranslate): string {
  switch (authType) {
    case "none":
      return t("mcpServerDetailModal.authNone");
    case "bearer":
      return t("mcpServerDetailModal.authBearerToken");
    case "api-key":
      return t("mcpServerDetailModal.authApiKey");
  }
}

interface McpServerDetailModalProps {
  server: McpServerEntry | null;
  toolsSummary: McpToolsSummaryServer | undefined;
  toolsLoading?: boolean;
  toolsError?: boolean;
  onClose: () => void;
  onSave: (
    serverId: string,
    updates: {
      name: string;
      headers?: Record<string, string> | null;
    },
  ) => void;
  isPending: boolean;
}

export function McpServerDetailModal({
  server,
  toolsSummary,
  toolsLoading = false,
  toolsError = false,
  onClose,
  onSave,
  isPending,
}: McpServerDetailModalProps) {
  const { t } = useTranslation("settings");
  const [authType, setAuthType] = useState<AuthType>("none");
  const [bearerToken, setBearerToken] = useState("");
  const [apiKeyHeader, setApiKeyHeader] = useState("X-API-Key");
  const [apiKeyValue, setApiKeyValue] = useState("");

  useEffect(() => {
    if (server) {
      setAuthType(server.authType);
      // Credential store never returns raw values. Reset secret fields.
      // Preserve the non-secret header name for API-key auth rotations.
      setBearerToken("");
      setApiKeyHeader(server.authHeaderName ?? "X-API-Key");
      setApiKeyValue("");
    }
  }, [server]);

  const handleSave = useCallback(() => {
    if (!server) {
      return;
    }

    // Determine if auth was changed: type switched, or new values entered
    const typeChanged = authType !== server.authType;
    const hasNewBearerValue =
      authType === "bearer" && bearerToken.trim() !== "";
    const hasNewApiKeyValue =
      authType === "api-key" &&
      apiKeyHeader.trim() !== "" &&
      apiKeyValue.trim() !== "";
    const authChanged = typeChanged || hasNewBearerValue || hasNewApiKeyValue;

    let headers: Record<string, string> | null | undefined;
    if (!authChanged) {
      headers = undefined;
    } else if (authType === "none") {
      headers = null;
    } else if (authType === "bearer" && bearerToken.trim()) {
      headers = { Authorization: `Bearer ${bearerToken.trim()}` };
    } else if (
      authType === "api-key" &&
      apiKeyHeader.trim() &&
      apiKeyValue.trim()
    ) {
      headers = { [apiKeyHeader.trim()]: apiKeyValue.trim() };
    } else {
      headers = undefined;
    }

    onSave(server.id, {
      name: server.id,
      ...(headers !== undefined ? { headers } : {}),
    });
  }, [
    server,
    authType,
    bearerToken,
    apiKeyHeader,
    apiKeyValue,
    onSave,
  ]);

  const handleClose = useCallback(() => {
    if (!isPending) {
      onClose();
    }
  }, [isPending, onClose]);

  if (!server) {
    return null;
  }

  return (
    <Modal.Root
      open={!!server}
      onOpenChange={(next) => {
        if (!next) {
          handleClose();
        }
      }}
    >
      <Modal.Content size="lg">
        <Modal.Header icon={Cable}>
          <Modal.Title className="[overflow-wrap:anywhere]">{server.id}</Modal.Title>
          <Modal.Description>
            {t("mcpServerDetailModal.description", {
              transport: server.transport.type,
              status: server.status,
            })}
          </Modal.Description>
        </Modal.Header>

        <Modal.Body>
          <div className="space-y-5">
            {server.transport.type !== "stdio" ? (
              <>
                {server.hasOAuth ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] px-3 py-2">
                    <span className="text-body-small-default text-[var(--content-secondary)]">
                      {t("mcpServerDetailModal.authentication")}
                    </span>
                    <span className="rounded-full bg-[var(--surface-lift)] px-2 py-0.5 text-label-small-default text-[var(--content-default)]">
                      {t("mcpServerDetailModal.oauthBadge")}
                    </span>
                    <span className="text-body-small-default text-[var(--content-tertiary)]">
                      {t("mcpServerDetailModal.oauthManagedHint")}
                    </span>
                  </div>
                ) : null}

                {!server.hasOAuth ? (
                  <div className="space-y-1.5">
                    <label
                      className="text-body-small-default text-[var(--content-secondary)]"
                      htmlFor="mcp-detail-auth"
                    >
                      {t("mcpServerDetailModal.authentication")}
                    </label>
                    <select
                      id="mcp-detail-auth"
                      value={authType}
                      onChange={(e) => setAuthType(e.target.value as AuthType)}
                      className="w-full rounded-md border border-[var(--border-element)] bg-[var(--surface-lift)] px-3 py-1.5 text-body-medium-default text-[var(--content-default)] outline-none focus:ring-2 focus:ring-[var(--ring)]"
                    >
                      {AUTH_OPTION_VALUES.map((value) => (
                        <option key={value} value={value}>
                          {authOptionLabel(value, t)}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {authType === "bearer" && !server.hasOAuth ? (
                  <div className="space-y-1.5">
                    <label
                      className="text-body-small-default text-[var(--content-secondary)]"
                      htmlFor="mcp-detail-bearer"
                    >
                      {t("mcpServerDetailModal.bearerToken")}
                    </label>
                    <Input
                      id="mcp-detail-bearer"
                      type="password"
                      value={bearerToken}
                      onChange={(e) => setBearerToken(e.target.value)}
                      placeholder={
                        server.hasStaticAuth && server.authType === "bearer"
                          ? t("mcpServerDetailModal.savedTokenPlaceholder")
                          : t("mcpServerDetailModal.bearerTokenPlaceholder")
                      }
                      fullWidth
                    />
                  </div>
                ) : null}

                {authType === "api-key" && !server.hasOAuth ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex-1 space-y-1.5">
                      <label
                        className="text-body-small-default text-[var(--content-secondary)]"
                        htmlFor="mcp-detail-apikey-header"
                      >
                        {t("mcpServerDetailModal.headerName")}
                      </label>
                      <Input
                        id="mcp-detail-apikey-header"
                        type="text"
                        value={apiKeyHeader}
                        onChange={(e) => setApiKeyHeader(e.target.value)}
                        placeholder={t(
                          "mcpServerDetailModal.headerNamePlaceholder",
                        )}
                        fullWidth
                      />
                    </div>
                    <div className="flex-1 space-y-1.5">
                      <label
                        className="text-body-small-default text-[var(--content-secondary)]"
                        htmlFor="mcp-detail-apikey-value"
                      >
                        {t("mcpServerDetailModal.apiKey")}
                      </label>
                      <Input
                        id="mcp-detail-apikey-value"
                        type="password"
                        value={apiKeyValue}
                        onChange={(e) => setApiKeyValue(e.target.value)}
                        placeholder={
                          server.hasStaticAuth && server.authType === "api-key"
                            ? t("mcpServerDetailModal.apiKeyPlaceholderKeep")
                            : t("mcpServerDetailModal.apiKeyPlaceholder")
                        }
                        fullWidth
                      />
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}

            {server.transport.url || server.transport.command ? (
              <dl className="space-y-1 text-body-small-default">
                <dt className="text-[var(--content-secondary)]">
                  {server.transport.type === "stdio"
                    ? t("mcpServerDetailModal.command")
                    : t("mcpServerDetailModal.endpoint")}
                </dt>
                <dd className="text-[var(--content-tertiary)] [overflow-wrap:anywhere]">
                  {server.transport.url ?? server.transport.command}
                </dd>
              </dl>
            ) : null}

            <section className="space-y-2">
              <h3 className="text-body-medium-default text-[var(--content-default)]">
                {t("mcpServerDetailModal.toolsHeading")}
              </h3>
              {toolsLoading ? (
                <p role="status" className="text-body-small-default text-[var(--content-tertiary)]">
                  {t("mcpServerDetailModal.toolsLoading")}
                </p>
              ) : toolsError ? (
                <p role="alert" className="text-body-small-default text-[var(--content-tertiary)]">
                  {t("mcpServerDetailModal.toolsError")}
                </p>
              ) : toolsSummary && toolsSummary.tools.length > 0 ? (
                <>
                  <p className="text-body-small-default text-[var(--content-tertiary)]">
                    {t("mcpServerDetailModal.tokenOverhead", {
                      count: toolsSummary.estimatedTokens.toLocaleString(),
                    })}
                  </p>
                  <ul className="divide-y divide-[var(--border-base)] rounded-lg border border-[var(--border-base)]">
                    {toolsSummary.tools.map((tool) => (
                      <li key={tool.name} className="space-y-1 px-3 py-3">
                        <p className="text-body-small-default text-[var(--content-default)] [overflow-wrap:anywhere]">
                          {tool.name}
                        </p>
                        {tool.description ? (
                          <p className="whitespace-pre-wrap text-body-small-default text-[var(--content-secondary)] [overflow-wrap:anywhere]">
                            {tool.description}
                          </p>
                        ) : null}
                        <p className="text-body-small-default text-[var(--content-tertiary)]">
                          {t("mcpServerDetailModal.toolEstimatedTokens", {
                            count: tool.estimatedTokens.toLocaleString(),
                          })}
                        </p>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-body-small-default text-[var(--content-tertiary)]">
                  {t("mcpServerDetailModal.toolsEmpty")}
                </p>
              )}
            </section>
          </div>
        </Modal.Body>

        <Modal.Footer>
          <Button variant="ghost" onClick={handleClose} disabled={isPending}>
            {t("mcpServerDetailModal.cancel")}
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={isPending}>
            {isPending
              ? t("mcpServerDetailModal.saving")
              : t("mcpServerDetailModal.save")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
