import { Cable } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";

type TransportType = "stdio" | "sse" | "streamable-http";
type AuthType = "none" | "bearer" | "api-key" | "oauth";

const AUTH_OPTIONS: { value: AuthType; label: string }[] = [
  { value: "none", label: "None" },
  { value: "oauth", label: "OAuth" },
  { value: "bearer", label: "Bearer Token" },
  { value: "api-key", label: "API Key" },
];

const TRANSPORT_OPTIONS: { value: TransportType; label: string }[] = [
  { value: "sse", label: "SSE" },
  { value: "streamable-http", label: "Streamable HTTP" },
  { value: "stdio", label: "Stdio (command)" },
];

interface McpAddServerModalProps {
  open: boolean;
  onClose: () => void;
  onAdd: (config: {
    name: string;
    transportType: string;
    url?: string;
    command?: string;
    args?: string[];
    headers?: Record<string, string>;
    autoAuth?: boolean;
  }) => void;
  isPending: boolean;
}

export function McpAddServerModal({
  open,
  onClose,
  onAdd,
  isPending,
}: McpAddServerModalProps) {
  const [name, setName] = useState("");
  const [transportType, setTransportType] = useState<TransportType>("sse");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [authType, setAuthType] = useState<AuthType>("none");
  const [bearerToken, setBearerToken] = useState("");
  const [apiKeyHeader, setApiKeyHeader] = useState("X-API-Key");
  const [apiKeyValue, setApiKeyValue] = useState("");

  const resetForm = useCallback(() => {
    setName("");
    setTransportType("sse");
    setUrl("");
    setCommand("");
    setArgs("");
    setAuthType("none");
    setBearerToken("");
    setApiKeyHeader("X-API-Key");
    setApiKeyValue("");
  }, []);

  const handleClose = useCallback(() => {
    if (!isPending) {
      resetForm();
      onClose();
    }
  }, [isPending, resetForm, onClose]);

  const handleSubmit = useCallback(() => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }

    const config: {
      name: string;
      transportType: string;
      url?: string;
      command?: string;
      args?: string[];
      headers?: Record<string, string>;
      autoAuth?: boolean;
    } = { name: trimmedName, transportType };

    if (transportType === "stdio") {
      const trimmedCommand = command.trim();
      if (!trimmedCommand) {
        return;
      }
      config.command = trimmedCommand;
      const trimmedArgs = args.trim();
      if (trimmedArgs) {
        config.args = trimmedArgs.split(/\s+/);
      }
    } else {
      const trimmedUrl = url.trim();
      if (!trimmedUrl) {
        return;
      }
      config.url = trimmedUrl;

      if (authType === "bearer" && bearerToken.trim()) {
        config.headers = { Authorization: `Bearer ${bearerToken.trim()}` };
      } else if (authType === "api-key" && apiKeyHeader.trim() && apiKeyValue.trim()) {
        config.headers = { [apiKeyHeader.trim()]: apiKeyValue.trim() };
      } else if (authType === "oauth") {
        config.autoAuth = true;
      }
    }

    onAdd(config);
  }, [name, transportType, url, command, args, authType, bearerToken, apiKeyHeader, apiKeyValue, onAdd]);

  const isStdio = transportType === "stdio";
  const canSubmit = name.trim() && (isStdio ? command.trim() : url.trim());

  return (
    <Modal.Root open={open} onOpenChange={(next) => { if (!next) { handleClose(); } }}>
      <Modal.Content size="md">
        <Modal.Header>
          <Modal.Title icon={Cable}>Add MCP Server</Modal.Title>
          <Modal.Description>
            Connect to a Model Context Protocol server to extend available tools.
          </Modal.Description>
        </Modal.Header>

        <Modal.Body>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-body-small-default text-[var(--content-secondary)]" htmlFor="mcp-name">
                Server name
              </label>
              <Input
                id="mcp-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-server"
                fullWidth
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-body-small-default text-[var(--content-secondary)]" htmlFor="mcp-transport">
                Transport
              </label>
              <select
                id="mcp-transport"
                value={transportType}
                onChange={(e) => setTransportType(e.target.value as TransportType)}
                className="w-full rounded-md border border-[var(--border-element)] bg-[var(--surface-lift)] px-3 py-1.5 text-body-medium-default text-[var(--content-default)] outline-none focus:ring-2 focus:ring-[var(--ring)]"
              >
                {TRANSPORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {isStdio ? (
              <>
                <div className="space-y-1.5">
                  <label className="text-body-small-default text-[var(--content-secondary)]" htmlFor="mcp-command">
                    Command
                  </label>
                  <Input
                    id="mcp-command"
                    type="text"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="npx -y @modelcontextprotocol/server-example"
                    fullWidth
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-body-small-default text-[var(--content-secondary)]" htmlFor="mcp-args">
                    Arguments (space-separated)
                  </label>
                  <Input
                    id="mcp-args"
                    type="text"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder="--port 3000"
                    fullWidth
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <label className="text-body-small-default text-[var(--content-secondary)]" htmlFor="mcp-url">
                    Server URL
                  </label>
                  <Input
                    id="mcp-url"
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://example.com/mcp"
                    fullWidth
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-body-small-default text-[var(--content-secondary)]" htmlFor="mcp-auth">
                    Authentication
                  </label>
                  <select
                    id="mcp-auth"
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

                {authType === "oauth" ? (
                  <p className="rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] px-3 py-2 text-body-small-default text-[var(--content-tertiary)]">
                    OAuth credentials will be configured through a browser-based authorization flow after the server is added.
                  </p>
                ) : null}

                {authType === "bearer" ? (
                  <div className="space-y-1.5">
                    <label className="text-body-small-default text-[var(--content-secondary)]" htmlFor="mcp-bearer">
                      Bearer token
                    </label>
                    <Input
                      id="mcp-bearer"
                      type="password"
                      value={bearerToken}
                      onChange={(e) => setBearerToken(e.target.value)}
                      placeholder="tok_..."
                      fullWidth
                    />
                  </div>
                ) : null}

                {authType === "api-key" ? (
                  <div className="flex gap-3">
                    <div className="flex-1 space-y-1.5">
                      <label className="text-body-small-default text-[var(--content-secondary)]" htmlFor="mcp-apikey-header">
                        Header name
                      </label>
                      <Input
                        id="mcp-apikey-header"
                        type="text"
                        value={apiKeyHeader}
                        onChange={(e) => setApiKeyHeader(e.target.value)}
                        placeholder="X-API-Key"
                        fullWidth
                      />
                    </div>
                    <div className="flex-1 space-y-1.5">
                      <label className="text-body-small-default text-[var(--content-secondary)]" htmlFor="mcp-apikey-value">
                        API key
                      </label>
                      <Input
                        id="mcp-apikey-value"
                        type="password"
                        value={apiKeyValue}
                        onChange={(e) => setApiKeyValue(e.target.value)}
                        placeholder="sk_..."
                        fullWidth
                      />
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </Modal.Body>

        <Modal.Footer>
          <Button variant="ghost" onClick={handleClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!canSubmit || isPending}
          >
            {isPending ? "Adding..." : "Add Server"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
