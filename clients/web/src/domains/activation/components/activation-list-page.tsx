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
 *
 * Progress that has not landed yet is `undefined`, not an empty map, and the
 * rows are placeholders until it does. A missing record reads as "never
 * started", so rendering the real rows early would offer a finished task back
 * to the user and run its prompt a second time.
 */

import { Skeleton } from "@vellumai/design-library/components/skeleton";

import { PageShell } from "@/components/page-shell";
import { useTranslation } from "@/i18n";

import type { ActivationTask } from "../catalog";
import type { ActivationProgress } from "../hooks/use-activation-progress";
import { ActivationListRow } from "./activation-list-row";

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

/** One row's worth of placeholder: the disc, the title and the description. */
function ActivationListRowSkeleton() {
  return (
    <li className="flex items-start gap-3 border-b border-[var(--border-base)] px-3 py-4 last:border-b-0">
      <Skeleton className="h-[26px] w-[26px] shrink-0 rounded-full" />
      <div className="flex w-full flex-col gap-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </li>
  );
}

export function ActivationListPage({
  tasks,
  progress,
  pendingTaskIds,
  onLaunch,
  onOpenConversation,
  assistantId,
}: ActivationListPageProps) {
  const { t } = useTranslation("activation");
  const loading = progress === undefined;

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
        {/* The placeholders are the only signal the page is loading, so the
            list carries the loading semantics while they stand. */}
        <ul
          className="mt-10 mb-6 overflow-hidden rounded-lg border border-[var(--border-base)] bg-[var(--surface-lift)]"
          aria-busy={loading || undefined}
          role={loading ? "status" : undefined}
          aria-label={loading ? t("page.loading") : undefined}
        >
          {loading
            ? tasks.map((task) => <ActivationListRowSkeleton key={task.id} />)
            : tasks.map((task) => (
                <ActivationListRow
                  key={task.id}
                  task={task}
                  progress={progress[task.id]}
                  pending={pendingTaskIds?.has(task.id) ?? false}
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
