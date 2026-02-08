"use client";

import { Activity, Globe, Mail, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Agent } from "@/lib/db";

interface DetailsTabProps {
  agentId: string;
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

interface AgentDetails {
  instanceName: string | null;
  zone: string | null;
  machineType: string | null;
  ipAddress: string | null;
  agentEmail: string | null;
  stats: SystemStats | null;
}

export function DetailsTab({ agentId }: DetailsTabProps) {
  const [details, setDetails] = useState<AgentDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchDetails = useCallback(async () => {
    try {
      const response = await fetch(`/api/agents/${agentId}`);
      if (!response.ok) {
        return;
      }
      const agent: Agent = await response.json();
      const computeConfig = (agent.configuration as Record<string, any>)?.compute as
        | { instanceName?: string; zone?: string; machineType?: string }
        | undefined;
      const agentmailConfig = (agent.configuration as Record<string, any>)?.agentmail as
        | { inbox_id?: string }
        | undefined;

      let ipAddress: string | null = null;
      let stats: SystemStats | null = null;
      if (computeConfig?.instanceName) {
        try {
          const healthResponse = await fetch(`/api/agents/${agentId}/health`);
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

      setDetails({
        instanceName: computeConfig?.instanceName ?? null,
        zone: computeConfig?.zone ?? null,
        machineType: computeConfig?.machineType ?? null,
        ipAddress,
        agentEmail: agentmailConfig?.inbox_id ?? null,
        stats,
      });
    } catch (error: unknown) {
      console.error("Failed to fetch agent details:", error);
    } finally {
      setIsLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    fetchDetails();
  }, [fetchDetails]);

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
        Failed to load agent details
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <h2 className="mb-6 text-lg font-semibold text-zinc-900 dark:text-white">
        Agent Details
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
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="text-zinc-500 dark:text-zinc-400">CPU Usage</span>
                  <span className="font-mono text-zinc-900 dark:text-white">
                    {details.stats.cpu.percent.toFixed(1)}% ({details.stats.cpu.cores} cores)
                  </span>
                </div>
                <div className="h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
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
                <div className="flex items-center justify-between text-sm mb-1">
                  <span className="text-zinc-500 dark:text-zinc-400">Memory Usage</span>
                  <span className="font-mono text-zinc-900 dark:text-white">
                    {details.stats.memory.used_mb.toFixed(0)} / {details.stats.memory.total_mb.toFixed(0)} MB ({details.stats.memory.percent.toFixed(1)}%)
                  </span>
                </div>
                <div className="h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
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
            Agent Email
          </div>
          <div className="space-y-2">
            <DetailRow label="Email Address" value={details.agentEmail} />
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
