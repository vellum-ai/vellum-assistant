import { Cable } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { McpServerEntry, McpToolsSummaryServer } from "./mcp-api";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";

type AuthType = "none" | "bearer" | "api-key";

const AUTH_OPTIONS: { value: AuthType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "bearer", label: "Bearer Token" },
  { value: "api-key", label: "API Key" },
];

const RISK_LEVELS = ["low", "medium", "high"] as const;

interface McpServerDetailModalProps {
  server: McpServerEntry | null;
  toolsSummary: McpToolsSummaryServer | undefined;
  onClose: () => void;
  onSave: (serverId: string, updates: {
    name: string;
    defaultRiskLevel?: string;
    maxTools?: number;
    headers?: Record<string, string> | null;
  }) => void;
  isPending: boolean;
}

export function McpServerDetailModal({
  server,
  toolsSummary,
  onClose,
  onSave,
  isPending,
}: McpServerDetailModalProps) {
  const [riskLevel, setRiskLevel] = useState("medium");
  const [authType, setAuthType] = useState<AuthType>("none");
  const [bearerToken, setBearerToken] = useState("");
  const [apiKeyHeader, setApiKeyHeader] = useState("X-API-Key");
  const [apiKeyValue, setApiKeyValue] = useState("");

  useEffect(() => {
    if (server) {
      setRiskLevel(server.defaultRiskLevel);
      setAuthType(server.authType);
      // Credential store never returns raw values — reset secret fields.
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
    const hasNewBearerValue = authType === "bearer" && bearerToken.trim() !== "";
    const hasNewApiKeyValue =
      authType === "api-key" && apiKeyHeader.trim() !== "" && apiKeyValue.trim() !== "";
    const authChanged = typeChanged || hasNewBearerValue || hasNewApiKeyValue;

    let headers: Record<string, string> | null | undefined;
    if (!authChanged) {
      headers = undefined;
    } else if (authType === "none") {
      headers = null;
    } else if (authType === "bearer" && bearerToken.trim()) {
      headers = { Authorization: `Bearer ${bearerToken.trim()}` };
    } else if (authType === "api-key" && apiKeyHeader.trim() && apiKeyValue.trim()) {
      headers = { [apiKeyHeader.trim()]: apiKeyValue.trim() };
    } else {
      headers = undefined;
    }

    onSave(server.id, {
      name: server.id,
      defaultRiskLevel: riskLevel,
      ...(headers !== undefined ? { headers } : {}),
    });
  }, [server, riskLevel, authType, bearerToken, apiKeyHeader, apiKeyValue, onSave]);

  const handleClose = useCallback(() => {
    if (!isPending) {
      onClose();
    }
  }, [isPending, onClose]);

  if (!server) {
    return null;
  }

  return (
    <Modal.Root open={!!server} onOpenChange={(next) => { if (!next) { handleClose(); } }}>
      <Modal.Content size="lg">
        <Modal.Header>
          <Modal.Title icon={Cable}>{server.id}</Modal.Title>
          <Modal.Description>
            {server.transport.type} transport &middot; {server.status}
          </Modal.Description>
        </Modal.Header>

        <Modal.Body>
          <div className="space-y-5">
            <div className="space-y-1.5">
              <label className="text-body-small-default text-[var(--content-secondary)]" htmlFor="mcp-risk">
                Default risk level
              </label>
              <select
                id="mcp-risk"
                value={riskLevel}
                onChange={(e) => setRiskLevel(e.target.value)}
                className="w-full rounded-md border border-[var(--border-element)] bg-[var(--surface-lift)] px-3 py-1.5 text-body-medium-default text-[var(--content-default)] outline-none focus:ring-2 focus:ring-[var(--ring)]"
              >
                {RISK_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level.charAt(0).toUpperCase() + level.slice(1)}
                  </option>
                ))}
              </select>
            </div>

            {server.transport.type !== "stdio" ? (
              <>
                {server.hasOAuth ? (
                  <div className="flex items-center gap-2 rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] px-3 py-2">
                    <span className="text-body-small-default text-[var(--content-secondary)]">
                      Authentication
                    </span>
                    <span className="rounded-full bg-[var(--surface-lift)] px-2 py-0.5 text-label-small-default text-[var(--content-default)]">
                      OAuth
                    </span>
                    <span className="text-body-small-default text-[var(--content-tertiary)]">
                      — managed via OAuth flow
                    </span>
                  </div>
                ) : null}

                {!server.hasOAuth ? (
                  <div className="space-y-1.5">
                    <label className="text-body-small-default text-[var(--content-secondary)]" htmlFor="mcp-detail-auth">
                      Authentication
                    </label>
                    <select
                      id="mcp-detail-auth"
                      value={authType}
                      onChange={(e) => setAuthType(e.target.value as AuthType)}
                      className="w-full rounded-md border border-[var(--border-element)] bg-[var(--surface-lift)] px-3 py-1.5 text-body-medium-default text-[var(--content-default)] outline-none focus:ring-2 focus:ring-[var(--ring)]"
                    >
                      {AUTH_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {authType === "bearer" && !server.hasOAuth ? (
                  <div className="space-y-1.5">
                    <label className="text-body-small-default text-[var(--content-secondary)]" htmlFor="mcp-detail-bearer">
                      Bearer token
                    </label>
                    <Input
                      id="mcp-detail-bearer"
                      type="password"
                      value={bearerToken}
                      onChange={(e) => setBearerToken(e.target.value)}
                      placeholder={server.hasStaticAuth && server.authType === "bearer" ? "••••••••  (leave blank to keep current)" : "tok_..."}
                      fullWidth
                    />
                  </div>
                ) : null}

                {authType === "api-key" && !server.hasOAuth ? (
                  <div className="flex gap-3">
                    <div className="flex-1 space-y-1.5">
                      <label className="text-body-small-default text-[var(--content-secondary)]" htmlFor="mcp-detail-apikey-header">
                        Header name
                      </label>
                      <Input
                        id="mcp-detail-apikey-header"
                        type="text"
                        value={apiKeyHeader}
                        onChange={(e) => setApiKeyHeader(e.target.value)}
                        placeholder="X-API-Key"
                        fullWidth
                      />
                    </div>
                    <div className="flex-1 space-y-1.5">
                      <label className="text-body-small-default text-[var(--content-secondary)]" htmlFor="mcp-detail-apikey-value">
                        API key
                      </label>
                      <Input
                        id="mcp-detail-apikey-value"
                        type="password"
                        value={apiKeyValue}
                        onChange={(e) => setApiKeyValue(e.target.value)}
                        placeholder={server.hasStaticAuth && server.authType === "api-key" ? "••••••••  (leave blank to keep current)" : "sk_..."}
                        fullWidth
                      />
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}

            {toolsSummary && toolsSummary.tools.length > 0 ? (
              <div className="space-y-2">
                <h3 className="text-body-medium-default text-[var(--content-default)]">
                  Registered tools ({toolsSummary.toolCount})
                </h3>
                <p className="text-body-small-default text-[var(--content-tertiary)]">
                  Total estimated token overhead: ~{toolsSummary.estimatedTokens.toLocaleString()} tokens
                </p>
                <div className="max-h-64 overflow-y-auto rounded-lg border border-[var(--border-base)]">
                  <table className="w-full text-body-small-default">
                    <thead>
                      <tr className="border-b border-[var(--border-base)] bg-[var(--surface-base)]">
                        <th className="px-3 py-2 text-left font-medium text-[var(--content-secondary)]">Tool</th>
                        <th className="px-3 py-2 text-left font-medium text-[var(--content-secondary)]">Description</th>
                        <th className="px-3 py-2 text-right font-medium text-[var(--content-secondary)]">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {toolsSummary.tools.map((tool) => (
                        <tr key={tool.name} className="border-b border-[var(--border-base)] last:border-b-0">
                          <td className="px-3 py-2 font-medium text-[var(--content-default)]">{tool.name}</td>
                          <td className="max-w-xs truncate px-3 py-2 text-[var(--content-tertiary)]">
                            {tool.description || "\u2014"}
                          </td>
                          <td className="px-3 py-2 text-right text-[var(--content-tertiary)]">
                            ~{tool.estimatedTokens.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </div>
        </Modal.Body>

        <Modal.Footer>
          <Button variant="ghost" onClick={handleClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={isPending}>
            {isPending ? "Saving..." : "Save"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
