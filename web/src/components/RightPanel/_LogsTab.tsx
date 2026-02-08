"use client";

import { FileText, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface LogsTabProps {
  agentId: string;
}

export function LogsTab({ agentId }: LogsTabProps) {
  const [logDates, setLogDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [logContent, setLogContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLogDates = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/assistants/${agentId}/logs`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to fetch logs");
      }
      const data = await response.json();
      const files: string[] = data.files || [];
      setLogDates(files);
      if (files.length > 0 && !selectedDate) {
        setSelectedDate(files[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch logs");
    } finally {
      setIsLoading(false);
    }
  }, [agentId, selectedDate]);

  const fetchLogContent = useCallback(
    async (date: string) => {
      setIsLoadingContent(true);
      try {
        const response = await fetch(
          `/api/assistants/${agentId}/logs?date=${encodeURIComponent(date)}`
        );
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "Failed to fetch log content");
        }
        const data = await response.json();
        setLogContent(data.content || "");
      } catch (err) {
        setLogContent(
          err instanceof Error ? err.message : "Failed to load log content"
        );
      } finally {
        setIsLoadingContent(false);
      }
    },
    [agentId]
  );

  useEffect(() => {
    fetchLogDates();
  }, [fetchLogDates]);

  useEffect(() => {
    if (selectedDate) {
      fetchLogContent(selectedDate);
    }
  }, [selectedDate, fetchLogContent]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-zinc-400" />
          <span className="text-sm font-medium text-zinc-900 dark:text-white">
            Agent Logs
          </span>
        </div>
        <button
          onClick={fetchLogDates}
          disabled={isLoading}
          className="flex cursor-pointer items-center justify-center rounded p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
        >
          <RefreshCw
            className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`}
          />
        </button>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
        </div>
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <FileText className="h-12 w-12 text-zinc-300 dark:text-zinc-700" />
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            {error}
          </p>
        </div>
      ) : logDates.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <FileText className="h-12 w-12 text-zinc-300 dark:text-zinc-700" />
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            No logs available yet
          </p>
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex gap-1 overflow-x-auto border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
            {logDates.map((date) => (
              <button
                key={date}
                onClick={() => setSelectedDate(date)}
                className={`cursor-pointer whitespace-nowrap rounded px-3 py-1 text-xs font-medium transition-colors ${
                  selectedDate === date
                    ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-400"
                    : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                {date}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-auto bg-zinc-950 p-4">
            {isLoadingContent ? (
              <div className="flex items-center justify-center py-8">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
              </div>
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-green-400">
                {logContent}
              </pre>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
