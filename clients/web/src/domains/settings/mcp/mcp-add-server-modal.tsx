import { Cable } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useTranslation } from "@/i18n";
import { Button } from "@vellumai/design-library/components/button";
import { Input } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";

type TransportType = "stdio" | "sse" | "streamable-http";
type AuthType = "none" | "bearer" | "api-key" | "oauth";

type SettingsTranslate = ReturnType<typeof useTranslation<"settings">>["t"];

const AUTH_OPTION_KEYS = [
  { value: "none", labelKey: "mcpAddServerModal.authNone" },
  { value: "oauth", labelKey: "mcpAddServerModal.authOAuth" },
  { value: "bearer", labelKey: "mcpAddServerModal.authBearer" },
  { value: "api-key", labelKey: "mcpAddServerModal.authApiKey" },
] as const satisfies ReadonlyArray<{
  value: AuthType;
  labelKey: string;
}>;

const TRANSPORT_OPTION_KEYS = [
  { value: "sse", labelKey: "mcpAddServerModal.transportSse" },
  {
    value: "streamable-http",
    labelKey: "mcpAddServerModal.transportStreamableHttp",
  },
  { value: "stdio", labelKey: "mcpAddServerModal.transportStdio" },
] as const satisfies ReadonlyArray<{
  value: TransportType;
  labelKey: string;
}>;

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

function authOptions(t: SettingsTranslate) {
  return AUTH_OPTION_KEYS.map(({ value, labelKey }) => ({
    value,
    label: t(labelKey),
  }));
}

function transportOptions(t: SettingsTranslate) {
  return TRANSPORT_OPTION_KEYS.map(({ value, labelKey }) => ({
    value,
    label: t(labelKey),
  }));
}

export function McpAddServerModal({
  open,
  onClose,
  onAdd,
  isPending,
}: McpAddServerModalProps) {
  const { t } = useTranslation("settings");
  const authOptionsList = useMemo(() => authOptions(t), [t]);
  const transportOptionsList = useMemo(() => transportOptions(t), [t]);

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
      } else if (
        authType === "api-key" &&
        apiKeyHeader.trim() &&
        apiKeyValue.trim()
      ) {
        config.headers = { [apiKeyHeader.trim()]: apiKeyValue.trim() };
      } else if (authType === "oauth") {
        config.autoAuth = true;
      }
    }

    onAdd(config);
  }, [
    name,
    transportType,
    url,
    command,
    args,
    authType,
    bearerToken,
    apiKeyHeader,
    apiKeyValue,
    onAdd,
  ]);

  const isStdio = transportType === "stdio";
  const canSubmit = name.trim() && (isStdio ? command.trim() : url.trim());

  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          handleClose();
        }
      }}
    >
      <Modal.Content size="md">
        <Modal.Header icon={Cable}>
          <Modal.Title>{t("mcpAddServerModal.title")}</Modal.Title>
          <Modal.Description>
            {t("mcpAddServerModal.description")}
          </Modal.Description>
        </Modal.Header>

        <Modal.Body>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label
                className="text-body-small-default text-[var(--content-secondary)]"
                htmlFor="mcp-name"
              >
                {t("mcpAddServerModal.serverNameLabel")}
              </label>
              <Input
                id="mcp-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("mcpAddServerModal.namePlaceholder")}
                fullWidth
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <label
                className="text-body-small-default text-[var(--content-secondary)]"
                htmlFor="mcp-transport"
              >
                {t("mcpAddServerModal.transportLabel")}
              </label>
              <select
                id="mcp-transport"
                value={transportType}
                onChange={(e) =>
                  setTransportType(e.target.value as TransportType)
                }
                className="w-full rounded-md border border-[var(--border-element)] bg-[var(--surface-lift)] px-3 py-1.5 text-body-medium-default text-[var(--content-default)] outline-none focus:ring-2 focus:ring-[var(--ring)]"
              >
                {transportOptionsList.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {isStdio ? (
              <>
                <div className="space-y-1.5">
                  <label
                    className="text-body-small-default text-[var(--content-secondary)]"
                    htmlFor="mcp-command"
                  >
                    {t("mcpAddServerModal.commandLabel")}
                  </label>
                  <Input
                    id="mcp-command"
                    type="text"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder={t("mcpAddServerModal.commandPlaceholder")}
                    fullWidth
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    className="text-body-small-default text-[var(--content-secondary)]"
                    htmlFor="mcp-args"
                  >
                    {t("mcpAddServerModal.argsLabel")}
                  </label>
                  <Input
                    id="mcp-args"
                    type="text"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder={t("mcpAddServerModal.argsPlaceholder")}
                    fullWidth
                  />
                </div>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <label
                    className="text-body-small-default text-[var(--content-secondary)]"
                    htmlFor="mcp-url"
                  >
                    {t("mcpAddServerModal.serverUrlLabel")}
                  </label>
                  <Input
                    id="mcp-url"
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder={t("mcpAddServerModal.urlPlaceholder")}
                    fullWidth
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    className="text-body-small-default text-[var(--content-secondary)]"
                    htmlFor="mcp-auth"
                  >
                    {t("mcpAddServerModal.authenticationLabel")}
                  </label>
                  <select
                    id="mcp-auth"
                    value={authType}
                    onChange={(e) => setAuthType(e.target.value as AuthType)}
                    className="w-full rounded-md border border-[var(--border-element)] bg-[var(--surface-lift)] px-3 py-1.5 text-body-medium-default text-[var(--content-default)] outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  >
                    {authOptionsList.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {authType === "oauth" ? (
                  <p className="rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] px-3 py-2 text-body-small-default text-[var(--content-tertiary)]">
                    {t("mcpAddServerModal.oauthHint")}
                  </p>
                ) : null}

                {authType === "bearer" ? (
                  <div className="space-y-1.5">
                    <label
                      className="text-body-small-default text-[var(--content-secondary)]"
                      htmlFor="mcp-bearer"
                    >
                      {t("mcpAddServerModal.bearerTokenLabel")}
                    </label>
                    <Input
                      id="mcp-bearer"
                      type="password"
                      value={bearerToken}
                      onChange={(e) => setBearerToken(e.target.value)}
                      placeholder={t("mcpAddServerModal.bearerPlaceholder")}
                      fullWidth
                    />
                  </div>
                ) : null}

                {authType === "api-key" ? (
                  <div className="flex gap-3">
                    <div className="flex-1 space-y-1.5">
                      <label
                        className="text-body-small-default text-[var(--content-secondary)]"
                        htmlFor="mcp-apikey-header"
                      >
                        {t("mcpAddServerModal.headerNameLabel")}
                      </label>
                      <Input
                        id="mcp-apikey-header"
                        type="text"
                        value={apiKeyHeader}
                        onChange={(e) => setApiKeyHeader(e.target.value)}
                        placeholder={t(
                          "mcpAddServerModal.apiKeyHeaderPlaceholder",
                        )}
                        fullWidth
                      />
                    </div>
                    <div className="flex-1 space-y-1.5">
                      <label
                        className="text-body-small-default text-[var(--content-secondary)]"
                        htmlFor="mcp-apikey-value"
                      >
                        {t("mcpAddServerModal.apiKeyLabel")}
                      </label>
                      <Input
                        id="mcp-apikey-value"
                        type="password"
                        value={apiKeyValue}
                        onChange={(e) => setApiKeyValue(e.target.value)}
                        placeholder={t("mcpAddServerModal.apiKeyPlaceholder")}
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
            {t("mcpAddServerModal.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={!canSubmit || isPending}
          >
            {isPending
              ? t("mcpAddServerModal.adding")
              : t("mcpAddServerModal.addServer")}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
