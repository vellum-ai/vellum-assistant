"use client";

import { Bot, Cog, Lock, Plus, User, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { Layout } from "@/components/Layout";
import { useAuth } from "@/lib/auth";
import { Agent } from "@/lib/db";
import { AgentType } from "@/lib/gcp";

export default function AgentsPage() {
  const router = useRouter();
  const { isLoggedIn, isLoading: isAuthLoading, username } = useAuth();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState<AgentType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progressMessage, setProgressMessage] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    if (isAuthLoading || !isLoggedIn) {
      setIsLoading(false);
      return;
    }
    try {
      const response = await fetch("/api/agents");
      if (!response.ok) {
        throw new Error("Failed to fetch agents");
      }
      const data = await response.json();
      setAgents(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  }, [isAuthLoading, isLoggedIn]);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  const handleCreateAgent = async (agentType: AgentType) => {
    setIsCreating(agentType);
    setProgressMessage("Initializing...");
    setError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (username) {
        headers["x-username"] = username;
      }
      const response = await fetch("/api/agents", {
        method: "POST",
        headers,
        body: JSON.stringify({ agent_type: agentType }),
      });

      if (!response.ok) {
        throw new Error("Failed to create agent");
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response stream");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            const eventType = line.slice(7);
            const dataLineIndex = lines.indexOf(line) + 1;
            const dataLine = lines[dataLineIndex];
            if (dataLine?.startsWith("data: ")) {
              const data = JSON.parse(dataLine.slice(6));
              if (eventType === "progress") {
                setProgressMessage(data.message);
              } else if (eventType === "complete") {
                router.push(`/agents/${data.agent.id}`);
                return;
              } else if (eventType === "error") {
                throw new Error(data.message);
              }
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create agent");
      setIsCreating(null);
      setProgressMessage(null);
    }
  };


  if (isAuthLoading) {
    return null;
  }

  if (!isLoggedIn) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center px-4 py-16">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
            <Lock className="h-8 w-8 text-zinc-400" />
          </div>
          <h2 className="mt-6 text-xl font-semibold text-zinc-900 dark:text-white">
            Sign in required
          </h2>
          <p className="mt-2 text-center text-sm text-zinc-500 dark:text-zinc-400">
            Please sign in from the Home page to view and manage your agents.
          </p>
          <Link
            href="/"
            className="mt-6 flex items-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
          >
            Go to Home
          </Link>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      {isCreating && progressMessage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="relative w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
            <button
              onClick={() => {
                setIsCreating(null);
                setProgressMessage(null);
              }}
              className="absolute top-3 right-3 rounded-full p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="flex flex-col items-center gap-4">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
              <div className="text-center">
                <h3 className="text-base font-semibold text-zinc-900 dark:text-white">
                  Creating Agent
                </h3>
                <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
                  {progressMessage}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="p-4 sm:p-8">
        <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl dark:text-white">
              Agents
            </h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Create and manage your AI agents
            </p>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <button
              onClick={() => handleCreateAgent("simple")}
              disabled={isCreating !== null}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50 sm:w-auto"
            >
              <Plus className="h-4 w-4" />
              {isCreating === "simple" ? "Creating..." : "Simple"}
            </button>
            <button
              onClick={() => handleCreateAgent("vellyclaw")}
              disabled={isCreating !== null}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-700 disabled:opacity-50 sm:w-auto"
            >
              <Cog className="h-4 w-4" />
              {isCreating === "vellyclaw" ? "Creating..." : "VellyClaw"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 p-4 text-sm text-red-600 dark:bg-red-950 dark:text-red-400">
            {error}
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
          </div>
        ) : agents.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-zinc-200 px-4 py-12 dark:border-zinc-800">
            <Bot className="h-12 w-12 text-zinc-400" />
            <h3 className="mt-4 text-lg font-medium text-zinc-900 dark:text-white">
              No agents yet
            </h3>
            <p className="mt-1 text-center text-sm text-zinc-500 dark:text-zinc-400">
              Get started by creating your first agent
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => handleCreateAgent("simple")}
                disabled={isCreating !== null}
                className="flex cursor-pointer items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                {isCreating === "simple" ? "Creating..." : "Simple"}
              </button>
              <button
                onClick={() => handleCreateAgent("vellyclaw")}
                disabled={isCreating !== null}
                className="flex cursor-pointer items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-orange-700 disabled:opacity-50"
              >
                <Cog className="h-4 w-4" />
                {isCreating === "vellyclaw" ? "Creating..." : "VellyClaw"}
              </button>
            </div>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
              <div
                key={agent.id}
                onClick={() => router.push(`/agents/${agent.id}`)}
                className="group cursor-pointer rounded-lg border border-zinc-200 bg-white p-4 transition-all hover:border-indigo-300 hover:shadow-md sm:p-6 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-indigo-700"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-950">
                  <Bot className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                </div>
                <h3 className="mt-4 font-medium text-zinc-900 dark:text-white">
                  {agent.name}
                </h3>
                {agent.created_by && (
                  <div className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                    <User className="h-3 w-3" />
                    <span>{agent.created_by}</span>
                  </div>
                )}
                <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
                  Created {new Date(agent.created_at).toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
