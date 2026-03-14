"use client";

import { ArrowRight, Bot } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { DynamicEditor } from "@/components/DynamicEditor";
import { Layout } from "@/components/Layout";
import { useAuth } from "@/lib/auth";
import { Assistant } from "@/lib/db";
import { isPlatformLoginEnabled } from "@/lib/feature-flags";

export default function AssistantPage() {
  const router = useRouter();
  const { isLoggedIn, isLoading: isAuthLoading, username } = useAuth();
  const [assistants, setAssistants] = useState<Assistant[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isHatching, setIsHatching] = useState(false);

  const platformLoginEnabled = isPlatformLoginEnabled();

  const fetchAssistants = useCallback(async () => {
    if (isAuthLoading && platformLoginEnabled) {
      return;
    }
    
    if (!isLoggedIn && platformLoginEnabled) {
      router.push("/login");
      return;
    }

    try {
      const response = await fetch("/api/agents");
      if (!response.ok) {
        throw new Error("Failed to fetch assistants");
      }
      const data = await response.json();
      setAssistants(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  }, [isAuthLoading, isLoggedIn, platformLoginEnabled, router]);

  useEffect(() => {
    fetchAssistants();
  }, [fetchAssistants]);

  const handleHatchAssistant = async () => {
    setIsHatching(true);
    setError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (username) {
        headers["x-username"] = username;
      }
      const response = await fetch("/api/agents", {
        method: "POST",
        headers,
        body: JSON.stringify({ agent_type: "simple" }),
      });

      if (!response.ok) {
        throw new Error("Failed to hatch assistant");
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
              if (eventType === "complete") {
                // Refresh the page to show the new assistant
                await fetchAssistants();
                return;
              } else if (eventType === "error") {
                throw new Error(data.message);
              }
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to hatch assistant");
    } finally {
      setIsHatching(false);
    }
  };

  // Loading state
  if (isAuthLoading || isLoading) {
    return (
      <Layout>
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
        </div>
      </Layout>
    );
  }

  // No assistants - show "Hatch Assistant" button
  if (assistants.length === 0) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center px-4 py-16">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-950">
            <Bot className="h-10 w-10 text-indigo-600 dark:text-indigo-400" />
          </div>
          <h2 className="mt-6 text-2xl font-bold text-zinc-900 dark:text-white">
            Welcome to Vellum Assistant
          </h2>
          <p className="mt-2 text-center text-zinc-500 dark:text-zinc-400">
            You don&apos;t have an assistant yet. Let&apos;s hatch one for you!
          </p>
          {error && (
            <div className="mt-4 rounded-lg bg-red-50 p-4 text-sm text-red-600 dark:bg-red-950 dark:text-red-400">
              {error}
            </div>
          )}
          <button
            onClick={handleHatchAssistant}
            disabled={isHatching}
            className="mt-6 flex items-center gap-2 rounded-lg bg-indigo-600 px-8 py-3 text-base font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
          >
            <Bot className="h-5 w-5" />
            {isHatching ? "Hatching..." : "Hatch Assistant"}
          </button>
        </div>
      </Layout>
    );
  }

  // Sort by createdAt ascending to get the oldest first
  const sortedAssistants = [...assistants].sort((a, b) => {
    const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return dateA - dateB;
  });

  const oldestAssistant = sortedAssistants[0];

  // One assistant - render the editor directly
  if (assistants.length === 1) {
    return (
      <div className="flex h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
        <DynamicEditor agentId={oldestAssistant.id} username={username} />
      </div>
    );
  }

  // Multiple assistants - show the oldest with link to /assistants
  return (
    <div className="flex h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <span>Showing oldest assistant</span>
        </div>
        <Link
          href="/assistants"
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700"
        >
          View All Assistants
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
      <DynamicEditor agentId={oldestAssistant.id} username={username} />
    </div>
  );
}
