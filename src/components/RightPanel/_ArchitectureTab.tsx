"use client";

import {
  Bot,
  Calendar,
  FileCode,
  Layers,
  MessageSquare,
  Wrench,
} from "lucide-react";

interface ArchitectureTabProps {
  agentName: string;
}

export function ArchitectureTab({ agentName }: ArchitectureTabProps) {
  return (
    <div className="flex h-full flex-col overflow-auto p-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="rounded-xl border-2 border-dashed border-zinc-300 bg-zinc-50 p-8 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex flex-col items-center">
            {/* Trigger Nodes Row */}
            <div className="mb-4 flex items-center gap-4">
              {/* Clock/Scheduled Trigger */}
              <div className="flex flex-col items-center">
                <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2 shadow-sm dark:border-amber-800 dark:bg-zinc-800">
                  <div className="flex h-6 w-6 items-center justify-center rounded bg-amber-100 dark:bg-amber-950">
                    <Calendar className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                  </div>
                  <span className="text-xs text-zinc-600 dark:text-zinc-300">
                    Scheduled
                  </span>
                </div>
                <div className="h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
                <div className="h-0 w-0 border-x-4 border-t-4 border-x-transparent border-t-zinc-300 dark:border-t-zinc-700" />
              </div>

              {/* Slack/Message Trigger */}
              <div className="flex flex-col items-center">
                <div className="flex items-center gap-2 rounded-lg border border-purple-200 bg-white px-3 py-2 shadow-sm dark:border-purple-800 dark:bg-zinc-800">
                  <div className="flex h-6 w-6 items-center justify-center rounded bg-purple-100 dark:bg-purple-950">
                    <MessageSquare className="h-3 w-3 text-purple-600 dark:text-purple-400" />
                  </div>
                  <span className="text-xs text-zinc-600 dark:text-zinc-300">
                    Slack
                  </span>
                </div>
                <div className="h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
                <div className="h-0 w-0 border-x-4 border-t-4 border-x-transparent border-t-zinc-300 dark:border-t-zinc-700" />
              </div>

              {/* FS/Agent-to-Agent Trigger */}
              <div className="flex flex-col items-center">
                <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-white px-3 py-2 shadow-sm dark:border-blue-800 dark:bg-zinc-800">
                  <div className="flex h-6 w-6 items-center justify-center rounded bg-blue-100 dark:bg-blue-950">
                    <Bot className="h-3 w-3 text-blue-600 dark:text-blue-400" />
                  </div>
                  <span className="text-xs text-zinc-600 dark:text-zinc-300">
                    Agent
                  </span>
                </div>
                <div className="h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
                <div className="h-0 w-0 border-x-4 border-t-4 border-x-transparent border-t-zinc-300 dark:border-t-zinc-700" />
              </div>
            </div>

            {/* Connector line from triggers to main agent */}
            <div className="mb-2 h-px w-48 bg-zinc-300 dark:bg-zinc-700" />
            <div className="mb-2 h-4 w-px bg-zinc-300 dark:bg-zinc-700" />

            {/* Main Agent Node */}
            <div className="flex items-center gap-3 rounded-lg border-2 border-indigo-300 bg-white px-5 py-4 shadow-md dark:border-indigo-700 dark:bg-zinc-800">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-950">
                <Layers className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
              </div>
              <div>
                <span className="font-semibold text-zinc-900 dark:text-white">
                  {agentName}
                </span>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  Main Agent
                </p>
              </div>
            </div>

            {/* Connector line from main agent to skills */}
            <div className="mt-2 h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
            <div className="h-0 w-0 border-x-4 border-t-4 border-x-transparent border-t-zinc-300 dark:border-t-zinc-700" />
            <div className="mt-2 h-px w-64 bg-zinc-300 dark:bg-zinc-700" />

            {/* Skills Row */}
            <div className="mt-4 flex items-start gap-4">
              {/* Skill 1 */}
              <div className="flex flex-col items-center">
                <div className="h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 py-2 shadow-sm dark:border-emerald-800 dark:bg-zinc-800">
                  <div className="flex h-6 w-6 items-center justify-center rounded bg-emerald-100 dark:bg-emerald-950">
                    <Wrench className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <span className="text-xs text-zinc-600 dark:text-zinc-300">
                    Search
                  </span>
                </div>
              </div>

              {/* Skill 2 */}
              <div className="flex flex-col items-center">
                <div className="h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 py-2 shadow-sm dark:border-emerald-800 dark:bg-zinc-800">
                  <div className="flex h-6 w-6 items-center justify-center rounded bg-emerald-100 dark:bg-emerald-950">
                    <FileCode className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <span className="text-xs text-zinc-600 dark:text-zinc-300">
                    Code
                  </span>
                </div>
              </div>

              {/* Skill 3 */}
              <div className="flex flex-col items-center">
                <div className="h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 py-2 shadow-sm dark:border-emerald-800 dark:bg-zinc-800">
                  <div className="flex h-6 w-6 items-center justify-center rounded bg-emerald-100 dark:bg-emerald-950">
                    <MessageSquare className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <span className="text-xs text-zinc-600 dark:text-zinc-300">
                    Chat
                  </span>
                </div>
              </div>

              {/* Skill 4 */}
              <div className="flex flex-col items-center">
                <div className="h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-white px-3 py-2 shadow-sm dark:border-emerald-800 dark:bg-zinc-800">
                  <div className="flex h-6 w-6 items-center justify-center rounded bg-emerald-100 dark:bg-emerald-950">
                    <Wrench className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <span className="text-xs text-zinc-600 dark:text-zinc-300">
                    API
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
