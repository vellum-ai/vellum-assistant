"use client";

import { GitBranch, Layers, Workflow } from "lucide-react";

interface ArchitectureDiagramProps {
  agentName: string;
}

export function ArchitectureDiagram({ agentName }: ArchitectureDiagramProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h2 className="font-medium text-zinc-900 dark:text-white">
          Architecture
        </h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Visual representation of your agent
        </p>
      </div>

      <div className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-md">
          {/* Placeholder Architecture Diagram */}
          <div className="rounded-xl border-2 border-dashed border-zinc-300 bg-zinc-50 p-8 dark:border-zinc-700 dark:bg-zinc-900">
            <div className="flex flex-col items-center">
              {/* Agent Node */}
              <div className="flex items-center gap-3 rounded-lg border border-indigo-200 bg-white px-4 py-3 shadow-sm dark:border-indigo-800 dark:bg-zinc-800">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-950">
                  <Layers className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                </div>
                <span className="font-medium text-zinc-900 dark:text-white">
                  {agentName}
                </span>
              </div>

              {/* Connector Line */}
              <div className="h-8 w-px bg-zinc-300 dark:bg-zinc-700" />

              {/* Workflow Node */}
              <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 shadow-sm dark:border-zinc-700 dark:bg-zinc-800">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-950">
                  <Workflow className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <span className="text-sm text-zinc-600 dark:text-zinc-300">
                  Workflow
                </span>
              </div>

              {/* Connector Lines */}
              <div className="flex items-start">
                <div className="flex flex-col items-center">
                  <div className="h-8 w-px bg-zinc-300 dark:bg-zinc-700" />
                  <div className="h-px w-16 bg-zinc-300 dark:bg-zinc-700" />
                </div>
                <div className="flex flex-col items-center">
                  <div className="h-8 w-px bg-zinc-300 dark:bg-zinc-700" />
                </div>
                <div className="flex flex-col items-center">
                  <div className="h-8 w-px bg-zinc-300 dark:bg-zinc-700" />
                  <div className="h-px w-16 bg-zinc-300 dark:bg-zinc-700" />
                </div>
              </div>

              {/* Branch Nodes */}
              <div className="flex gap-8">
                <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 shadow-sm dark:border-zinc-700 dark:bg-zinc-800">
                  <GitBranch className="h-4 w-4 text-amber-500" />
                  <span className="text-xs text-zinc-600 dark:text-zinc-300">
                    Branch A
                  </span>
                </div>
                <div className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 shadow-sm dark:border-zinc-700 dark:bg-zinc-800">
                  <GitBranch className="h-4 w-4 text-blue-500" />
                  <span className="text-xs text-zinc-600 dark:text-zinc-300">
                    Branch B
                  </span>
                </div>
              </div>
            </div>

            {/* Placeholder Message */}
            <div className="mt-8 text-center">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Architecture diagram placeholder
              </p>
              <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">
                This will display the agent&apos;s workflow structure
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
