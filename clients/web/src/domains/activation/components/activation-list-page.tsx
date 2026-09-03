/**
 * The Inspiration List: every task the active persona list offers, in catalog
 * order, with the daemon's progress on each (Figma Light 796 / Light 797).
 *
 * Flat and unsectioned by design: the list is browsed, not navigated, and
 * category headers would ask the reader to pick a bucket before picking a
 * task.
 *
 * Presentational. Every read and write is a prop, so the page renders the same
 * against a story fixture as against the daemon, and the route beside it owns
 * the catalog, the progress query and the launch.
 *
 * The rows are `ActivationTaskList` in its `list` surface, the same group the
 * welcome modal draws, so a task reads the same in both places and the
 * placeholders match the rows that replace them.
 */

import type { ReactNode } from "react";

import { PageShell } from "@/components/page-shell";
import { useTranslation } from "@/i18n";

import type { ActivationTask } from "../catalog";
import type { ActivationProgress } from "../hooks/use-activation-progress";
import { ActivationTaskList } from "./activation-task-list";

export interface ActivationListPageProps {
  /** Starters first, then the rest, exactly as the list orders them. */
  tasks: ActivationTask[];
  /**
   * The daemon's per-task records, keyed by task id. `undefined` while the
   * read is still out, which renders placeholder rows instead of actionable
   * ones.
   */
  progress: ActivationProgress["tasks"] | undefined;
  /** Every task whose launch is in flight. */
  pendingTaskIds?: ReadonlySet<string>;
  onLaunch: (taskId: string) => void;
  onOpenConversation: (conversationId: string) => void;
  assistantId?: string;
}

export function ActivationListPage({
  tasks,
  progress,
  pendingTaskIds,
  onLaunch,
  onOpenConversation,
  assistantId,
}: ActivationListPageProps): ReactNode {
  const { t } = useTranslation("activation");
  const loading = progress === undefined;

  return (
    <PageShell className="overflow-y-auto">
      <div className="mx-auto w-full max-w-[600px] px-4 md:px-0">
        {/* The serif brand headline, the same treatment the chat's empty
            state gives its greeting, a step down on mobile. */}
        <h1
          className="text-center text-[40px] leading-[1.2] tracking-[0.02em] text-[var(--content-emphasised)] md:text-[48px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          {t("page.title", { count: tasks.length })}
        </h1>
        {/* The placeholders are the only signal the page is loading, so the
            wrapper carries the loading semantics while they stand. It wraps
            rather than sits on the list itself: a `status` role on a `ul`
            replaces its list semantics, and the row count is what a reader
            navigating by list is here for. */}
        <div
          className="mt-10 mb-6"
          aria-busy={loading || undefined}
          role={loading ? "status" : undefined}
          aria-label={loading ? t("page.loading") : undefined}
        >
          <ActivationTaskList
            tasks={tasks}
            surface="list"
            progress={progress}
            pendingTaskIds={pendingTaskIds}
            onLaunch={onLaunch}
            onOpenConversation={onOpenConversation}
            assistantId={assistantId}
          />
        </div>
      </div>
    </PageShell>
  );
}
