/**
 * The Inspiration List: every task the active persona list offers, in catalog
 * order, with the daemon's progress on each (Figma Light 796 / Light 797).
 *
 * Flat and unsectioned by design (PLAN A10): the list is browsed, not
 * navigated, and category headers would ask the reader to pick a bucket
 * before picking a task.
 *
 * Presentational. Every read and write is a prop, so the page renders the same
 * against a story fixture as against the daemon, and the route beside it owns
 * the catalog, the progress query and the launch.
 */

import { PageShell } from "@/components/page-shell";
import { useTranslation } from "@/i18n";

import type { ActivationTask } from "../catalog";
import type { ActivationProgress } from "../hooks/use-activation-progress";
import { ActivationListRow } from "./activation-list-row";

export interface ActivationListPageProps {
  /** Starters first, then the rest, exactly as the list orders them. */
  tasks: ActivationTask[];
  /** The daemon's per-task records, keyed by task id. */
  progress: ActivationProgress["tasks"];
  /** The task whose launch is in flight, if any. */
  pendingTaskId?: string | null;
  onLaunch: (taskId: string) => void;
  onOpenConversation: (conversationId: string) => void;
  assistantId?: string;
}

export function ActivationListPage({
  tasks,
  progress,
  pendingTaskId,
  onLaunch,
  onOpenConversation,
  assistantId,
}: ActivationListPageProps) {
  const { t } = useTranslation("activation");

  return (
    <PageShell className="overflow-y-auto">
      <div className="mx-auto w-full max-w-[600px] px-4 md:px-0">
        {/* The serif brand headline, the same treatment the chat's empty
            state gives its greeting, a step down on mobile (PLAN A24). */}
        <h1
          className="text-center text-[40px] leading-[1.2] tracking-[0.02em] text-[var(--content-emphasised)] md:text-[48px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          {t("page.title", { count: tasks.length })}
        </h1>
        <ul className="mt-10 mb-6 overflow-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)]">
          {tasks.map((task) => (
            <ActivationListRow
              key={task.id}
              task={task}
              progress={progress[task.id]}
              pending={pendingTaskId === task.id}
              onLaunch={onLaunch}
              onOpenConversation={onOpenConversation}
              assistantId={assistantId}
            />
          ))}
        </ul>
      </div>
    </PageShell>
  );
}
