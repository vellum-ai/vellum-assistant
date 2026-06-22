import { Cable } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { McpServerEntry, McpToolsSummaryServer } from "./mcp-api";
import { Button } from "@vellumai/design-library/components/button";
import { Modal } from "@vellumai/design-library/components/modal";

const RISK_LEVELS = ["low", "medium", "high"] as const;

interface McpServerDetailModalProps {
  server: McpServerEntry | null;
  toolsSummary: McpToolsSummaryServer | undefined;
  onClose: () => void;
  onSave: (serverId: string, updates: {
    name: string;
    defaultRiskLevel?: string;
    maxTools?: number;
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

  useEffect(() => {
    if (server) {
      setRiskLevel(server.defaultRiskLevel);
    }
  }, [server]);

  const handleSave = useCallback(() => {
    if (!server) {
      return;
    }

    onSave(server.id, {
      name: server.id,
      defaultRiskLevel: riskLevel,
    });
  }, [server, riskLevel, onSave]);

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
