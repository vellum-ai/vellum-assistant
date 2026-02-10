"use client";

import {
  Activity,
  Globe,
  Mail,
  Server,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Assistant } from "@/lib/db";

interface DetailsTabProps {
  assistantId: string;
}

interface SystemStats {
  cpu: {
    percent: number;
    cores: number;
  } | null;
  memory: {
    total_mb: number;
    used_mb: number;
    percent: number;
  } | null;
}

interface TelegramChannel {
  id: string;
  enabled: boolean;
  status: string;
  lastError: string | null;
  config: {
    botId?: number;
    botUsername?: string;
    webhookUrl?: string;
  };
}

interface TelegramContact {
  id: string;
  external_user_id: string;
  external_chat_id: string;
  username: string | null;
  display_name: string | null;
  status: "pending" | "approved" | "blocked";
  last_seen_at: string | null;
}

interface AssistantDetails {
  instanceName: string | null;
  zone: string | null;
  machineType: string | null;
  ipAddress: string | null;
  assistantEmail: string | null;
  stats: SystemStats | null;
  telegramConfigured: boolean;
  telegramChannel: TelegramChannel | null;
  telegramContacts: TelegramContact[];
}

export function DetailsTab({ assistantId }: DetailsTabProps) {
  const [details, setDetails] = useState<AssistantDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [telegramToken, setTelegramToken] = useState("");
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [contactActionId, setContactActionId] = useState<string | null>(null);
  const [telegramError, setTelegramError] = useState<string | null>(null);
  const [telegramSuccess, setTelegramSuccess] = useState<string | null>(null);

  const fetchDetails = useCallback(async () => {
    try {
      const response = await fetch(`/api/assistants/${assistantId}`);
      if (!response.ok) {
        return;
      }
      const assistant: Assistant = await response.json();
      const computeConfig = (assistant.configuration as Record<string, unknown>)?.compute as
        | { instanceName?: string; zone?: string; machineType?: string }
        | undefined;
      const agentmailConfig = (assistant.configuration as Record<string, unknown>)?.agentmail as
        | { inbox_id?: string }
        | undefined;

      let ipAddress: string | null = null;
      let stats: SystemStats | null = null;
      if (computeConfig?.instanceName) {
        try {
          const healthResponse = await fetch(`/api/assistants/${assistantId}/health`);
          if (healthResponse.ok) {
            const healthData = await healthResponse.json();
            if (healthData.ip) {
              ipAddress = healthData.ip;
            }
            if (healthData.stats) {
              stats = healthData.stats;
            }
          }
        } catch {
          ipAddress = null;
        }
      }

      let telegramConfigured = false;
      let telegramChannel: TelegramChannel | null = null;
      let telegramContacts: TelegramContact[] = [];

      try {
        const telegramResponse = await fetch(
          `/api/assistants/${assistantId}/channels/telegram`
        );
        if (telegramResponse.ok) {
          const telegramData = (await telegramResponse.json()) as {
            configured: boolean;
            channel: TelegramChannel | null;
          };
          telegramConfigured = telegramData.configured;
          telegramChannel = telegramData.channel;

          if (telegramConfigured) {
            const contactsResponse = await fetch(
              `/api/assistants/${assistantId}/channels/telegram/contacts`
            );
            if (contactsResponse.ok) {
              const contactsData = (await contactsResponse.json()) as {
                contacts: TelegramContact[];
              };
              telegramContacts = contactsData.contacts || [];
            }
          }
        }
      } catch {
        // Ignore channel fetch errors in details panel.
      }

      setDetails({
        instanceName: computeConfig?.instanceName ?? null,
        zone: computeConfig?.zone ?? null,
        machineType: computeConfig?.machineType ?? null,
        ipAddress,
        assistantEmail: agentmailConfig?.inbox_id ?? null,
        stats,
        telegramConfigured,
        telegramChannel,
        telegramContacts,
      });
    } catch (error: unknown) {
      console.error("Failed to fetch assistant details:", error);
    } finally {
      setIsLoading(false);
    }
  }, [assistantId]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

  const pendingContacts = useMemo(
    () => details?.telegramContacts.filter((contact) => contact.status === "pending") ?? [],
    [details]
  );
  const approvedContacts = useMemo(
    () => details?.telegramContacts.filter((contact) => contact.status === "approved") ?? [],
    [details]
  );
  const blockedContacts = useMemo(
    () => details?.telegramContacts.filter((contact) => contact.status === "blocked") ?? [],
    [details]
  );

  const handleConnectTelegram = useCallback(async () => {
    const token = telegramToken.trim();
    if (!token) {
      setTelegramError("Bot token is required");
      return;
    }

    setTelegramError(null);
    setTelegramSuccess(null);
    setTelegramLoading(true);
    try {
      const response = await fetch(`/api/assistants/${assistantId}/channels/telegram`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botToken: token, enabled: true }),
      });

      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Failed to connect Telegram bot");
      }

      setTelegramToken("");
      setTelegramSuccess("Telegram bot connected");
      await fetchDetails();
    } catch (error) {
      setTelegramError(
        error instanceof Error ? error.message : "Failed to connect Telegram bot"
      );
    } finally {
      setTelegramLoading(false);
    }
  }, [assistantId, fetchDetails, telegramToken]);

  const handleDisconnectTelegram = useCallback(async () => {
    setTelegramError(null);
    setTelegramSuccess(null);
    setTelegramLoading(true);
    try {
      const response = await fetch(`/api/assistants/${assistantId}/channels/telegram`, {
        method: "DELETE",
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Failed to disconnect Telegram bot");
      }

      setTelegramSuccess("Telegram bot disconnected");
      await fetchDetails();
    } catch (error) {
      setTelegramError(
        error instanceof Error ? error.message : "Failed to disconnect Telegram bot"
      );
    } finally {
      setTelegramLoading(false);
    }
  }, [assistantId, fetchDetails]);

  const handleContactAction = useCallback(
    async (contactId: string, action: "approve" | "block") => {
      setTelegramError(null);
      setTelegramSuccess(null);
      setContactActionId(contactId);
      try {
        const response = await fetch(
          `/api/assistants/${assistantId}/channels/telegram/contacts/${contactId}/${action}`,
          { method: "POST" }
        );
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          throw new Error(data.error || `Failed to ${action} contact`);
        }

        setTelegramSuccess(
          action === "approve" ? "Contact approved" : "Contact blocked"
        );
        await fetchDetails();
      } catch (error) {
        setTelegramError(
          error instanceof Error ? error.message : `Failed to ${action} contact`
        );
      } finally {
        setContactActionId(null);
      }
    },
    [assistantId, fetchDetails]
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
      </div>
    );
  }

  if (!details) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
        Failed to load assistant details
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="mb-6 text-lg font-semibold text-zinc-900 dark:text-white">
        Assistant Details
      </h2>

      <div className="space-y-6">
        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-white">
            <Server className="h-4 w-4 text-indigo-500" />
            GCP Instance
          </div>
          <div className="space-y-2">
            <DetailRow label="Instance Name" value={details.instanceName} />
            <DetailRow label="Zone" value={details.zone} />
            <DetailRow label="Instance Type" value={details.machineType} />
          </div>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-white">
            <Globe className="h-4 w-4 text-green-500" />
            Network
          </div>
          <div className="space-y-2">
            <DetailRow label="IP Address" value={details.ipAddress} />
          </div>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-white">
            <Activity className="h-4 w-4 text-orange-500" />
            System Resources
          </div>
          <div className="space-y-3">
            {details.stats?.cpu ? (
              <div>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="text-zinc-500 dark:text-zinc-400">CPU Usage</span>
                  <span className="font-mono text-zinc-900 dark:text-white">
                    {details.stats.cpu.percent.toFixed(1)}% ({details.stats.cpu.cores} cores)
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                  <div
                    className="h-full bg-orange-500 transition-all duration-300"
                    style={{ width: `${Math.min(details.stats.cpu.percent, 100)}%` }}
                  />
                </div>
              </div>
            ) : (
              <DetailRow label="CPU Usage" value={null} />
            )}
            {details.stats?.memory ? (
              <div>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="text-zinc-500 dark:text-zinc-400">Memory Usage</span>
                  <span className="font-mono text-zinc-900 dark:text-white">
                    {details.stats.memory.used_mb.toFixed(0)} / {details.stats.memory.total_mb.toFixed(0)} MB ({details.stats.memory.percent.toFixed(1)}%)
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                  <div
                    className="h-full bg-blue-500 transition-all duration-300"
                    style={{ width: `${Math.min(details.stats.memory.percent, 100)}%` }}
                  />
                </div>
              </div>
            ) : (
              <DetailRow label="Memory Usage" value={null} />
            )}
          </div>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-white">
            <Mail className="h-4 w-4 text-blue-500" />
            Assistant Email
          </div>
          <div className="space-y-2">
            <DetailRow label="Email Address" value={details.assistantEmail} />
          </div>
        </div>

        <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-white">
            <ShieldCheck className="h-4 w-4 text-sky-500" />
            Telegram Bot (DM only)
          </div>

          <div className="space-y-3">
            <DetailRow
              label="Status"
              value={
                details.telegramConfigured
                  ? `${details.telegramChannel?.status || "active"}${
                      details.telegramChannel?.enabled ? " (enabled)" : " (disabled)"
                    }`
                  : "Not configured"
              }
            />
            <DetailRow
              label="Bot Username"
              value={
                details.telegramChannel?.config?.botUsername
                  ? `@${details.telegramChannel.config.botUsername}`
                  : null
              }
            />
            {details.telegramChannel?.lastError && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                {details.telegramChannel.lastError}
              </p>
            )}

            {telegramError && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                {telegramError}
              </p>
            )}
            {telegramSuccess && (
              <p className="rounded-md bg-green-50 px-3 py-2 text-xs text-green-700 dark:bg-green-950 dark:text-green-300">
                {telegramSuccess}
              </p>
            )}

            <div className="space-y-2">
              <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-300">
                Telegram Bot Token
              </label>
              <input
                type="password"
                value={telegramToken}
                onChange={(event) => setTelegramToken(event.target.value)}
                placeholder={details.telegramConfigured ? "Paste new token to rotate" : "123456:ABCDEF..."}
                className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-sky-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-white"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleConnectTelegram}
                disabled={telegramLoading}
                className="rounded-md bg-sky-600 px-3 py-2 text-xs font-medium text-white hover:bg-sky-700 disabled:opacity-60"
              >
                {telegramLoading
                  ? "Saving..."
                  : details.telegramConfigured
                    ? "Update Token"
                    : "Connect Telegram"}
              </button>
              {details.telegramConfigured && (
                <button
                  onClick={handleDisconnectTelegram}
                  disabled={telegramLoading}
                  className="rounded-md bg-zinc-200 px-3 py-2 text-xs font-medium text-zinc-900 hover:bg-zinc-300 disabled:opacity-60 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                >
                  Disconnect
                </button>
              )}
            </div>

            {details.telegramConfigured && (
              <div className="space-y-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                  <span>Pending: {pendingContacts.length}</span>
                  <span>Approved: {approvedContacts.length}</span>
                  <span>Blocked: {blockedContacts.length}</span>
                </div>

                {pendingContacts.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      Pending Approval
                    </h4>
                    {pendingContacts.map((contact) => (
                      <ContactRow
                        key={contact.id}
                        contact={contact}
                        actionLoading={contactActionId === contact.id}
                        onApprove={() => handleContactAction(contact.id, "approve")}
                        onBlock={() => handleContactAction(contact.id, "block")}
                      />
                    ))}
                  </div>
                )}

                {approvedContacts.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      Approved
                    </h4>
                    {approvedContacts.map((contact) => (
                      <ContactRow
                        key={contact.id}
                        contact={contact}
                        actionLoading={contactActionId === contact.id}
                        onBlock={() => handleContactAction(contact.id, "block")}
                      />
                    ))}
                  </div>
                )}

                {blockedContacts.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                      Blocked
                    </h4>
                    {blockedContacts.map((contact) => (
                      <ContactRow
                        key={contact.id}
                        contact={contact}
                        actionLoading={false}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
      <span className="font-mono text-zinc-900 dark:text-white">
        {value ?? "Not configured"}
      </span>
    </div>
  );
}

function ContactRow({
  contact,
  actionLoading,
  onApprove,
  onBlock,
}: {
  contact: TelegramContact;
  actionLoading: boolean;
  onApprove?: () => void;
  onBlock?: () => void;
}) {
  const label =
    contact.display_name ||
    (contact.username ? `@${contact.username}` : null) ||
    `user:${contact.external_user_id}`;

  return (
    <div className="rounded-md border border-zinc-200 p-2 text-xs dark:border-zinc-800">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-zinc-900 dark:text-zinc-100">{label}</p>
          <p className="truncate text-zinc-500 dark:text-zinc-400">chat:{contact.external_chat_id}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          {onApprove && (
            <button
              onClick={onApprove}
              disabled={actionLoading}
              className="rounded bg-green-600 px-2 py-1 text-white hover:bg-green-700 disabled:opacity-60"
            >
              Approve
            </button>
          )}
          {onBlock && (
            <button
              onClick={onBlock}
              disabled={actionLoading}
              className="inline-flex items-center gap-1 rounded bg-red-600 px-2 py-1 text-white hover:bg-red-700 disabled:opacity-60"
            >
              <ShieldX className="h-3 w-3" />
              Block
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
