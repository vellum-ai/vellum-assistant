/**
 * The checklist list surfaces: the bordered row group (Figma: New-App
 * `8300:168062`) and the Inspiration List page that wraps it in `PageShell`.
 *
 * A card that clips its contents, with a hairline between rows. `ListRow`'s
 * own sibling divider cannot draw it here because each row wraps its body in
 * an element of its own, which breaks the adjacent-sibling selector, so the
 * group owns the rule instead.
 *
 * Both the welcome modal and the full list draw the group through this one
 * component, so the border, the dividers and the placeholder rows are
 * measured once.
 *
 * Accordion state lives with the caller. The list only says which row is open,
 * so the modal and the list page can differ on what "open" means without this
 * component learning either answer.
 */

import type { ReactNode } from "react";

import { Card, Skeleton } from "@vellumai/design-library";

import { PageShell } from "@/components/page-shell";
import { useTranslation } from "@/i18n";

import type { ActivationTask } from "../catalog";
import type {
  ActivationProgress,
  ActivationTaskProgress,
} from "../hooks/use-activation-progress";
import {
  ActivationTaskRow,
  type ActivationRowSurface,
} from "./activation-task-row";

export interface ActivationTaskListProps {
  tasks: ActivationTask[];
  /**
   * The daemon's per-task records, keyed by task id. `undefined` while the
   * read is still out, which draws placeholder rows instead of actionable
   * ones: a missing record reads as "never started", so a real row rendered
   * early would offer a finished task back and run its prompt a second time.
   */
  progress: ActivationProgress["tasks"] | undefined;
  surface?: ActivationRowSurface;
  /** The open row, or null when every row is collapsed. Ignored on the list. */
  expandedTaskId?: string | null;
  onToggleTask?: (taskId: string) => void;
  onLaunch: (taskId: string, promptOverride?: string) => void;
  onOpenConversation: (conversationId: string) => void;
  /**
   * Every task whose launch is in flight. A set rather than one id: several
   * launches run at once, and each row locks only itself.
   */
  pendingTaskIds?: ReadonlySet<string>;
  assistantId?: string;
  className?: string;
}

/** One row's worth of placeholder: the disc, the title and the description. */
function ActivationTaskRowSkeleton(): ReactNode {
  return (
    <li className="flex items-start gap-3 px-3 py-4">
      <Skeleton className="h-[26px] w-[26px] shrink-0 rounded-full" />
      <div className="flex w-full flex-col gap-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </li>
  );
}

export function ActivationTaskList({
  tasks,
  progress,
  surface = "modal",
  expandedTaskId = null,
  onToggleTask,
  onLaunch,
  onOpenConversation,
  pendingTaskIds,
  assistantId,
  className,
}: ActivationTaskListProps): ReactNode {
  const loading = progress === undefined;

  return (
    <Card.Root bordered noPadding clipContents className={className}>
      <ul className="divide-y divide-[var(--border-base)]">
        {tasks.map((task) => {
          if (loading) {
            return <ActivationTaskRowSkeleton key={task.id} />;
          }
          const taskProgress: ActivationTaskProgress | undefined =
            progress[task.id];
          return (
            <li key={task.id}>
              <ActivationTaskRow
                task={task}
                surface={surface}
                progress={taskProgress}
                expanded={expandedTaskId === task.id}
                onToggle={() => onToggleTask?.(task.id)}
                onLaunch={(promptOverride) => onLaunch(task.id, promptOverride)}
                onOpenConversation={onOpenConversation}
                pending={pendingTaskIds?.has(task.id) ?? false}
                assistantId={assistantId}
              />
            </li>
          );
        })}
      </ul>
    </Card.Root>
  );
}

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

/**
 * The Inspiration List: every task the active persona list offers, in catalog
 * order, with the daemon's progress on each.
 *
 * Flat and unsectioned by design: the list is browsed, not navigated, and
 * category headers would ask the reader to pick a bucket before picking a
 * task.
 */
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
        <h1
          className="text-center text-[40px] leading-[1.2] tracking-[0.02em] text-[var(--content-emphasised)] md:text-[48px]"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          {t("page.title")}
        </h1>
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
