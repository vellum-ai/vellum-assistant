/**
 * The bordered group the checklist rows sit in (Figma: New-App `8300:168062`).
 *
 * A card that clips its contents, with a hairline between rows. `ListRow`'s
 * own sibling divider cannot draw it here because each row wraps its body in
 * an element of its own, which breaks the adjacent-sibling selector, so the
 * group owns the rule instead.
 *
 * Accordion state lives with the caller. The list only says which row is open,
 * so the modal and the list page can differ on what "open" means without this
 * component learning either answer.
 */

import type { ReactNode } from "react";

import { Card, cn } from "@vellumai/design-library";

import type { ActivationTask } from "../catalog";
import type { ActivationProgress } from "../hooks/use-activation-progress";
import { ActivationTaskRow } from "./activation-task-row";

export interface ActivationTaskListProps {
  tasks: ActivationTask[];
  progress: ActivationProgress;
  /** The open row, or null when every row is collapsed. */
  expandedTaskId: string | null;
  onToggleTask: (taskId: string) => void;
  onLaunch: (taskId: string, promptOverride?: string) => void;
  onOpenConversation: (conversationId: string) => void;
  /**
   * Whether that task's own launch is still in flight. Asked per task rather
   * than handed a single id: several launches run at once, and each row locks
   * only itself.
   */
  isPending?: (taskId: string) => boolean;
  assistantId?: string;
  className?: string;
}

export function ActivationTaskList({
  tasks,
  progress,
  expandedTaskId,
  onToggleTask,
  onLaunch,
  onOpenConversation,
  isPending,
  assistantId,
  className,
}: ActivationTaskListProps): ReactNode {
  return (
    <Card.Root
      bordered
      noPadding
      clipContents
      className={cn("divide-y divide-[var(--border-base)]", className)}
    >
      {tasks.map((task) => (
        <ActivationTaskRow
          key={task.id}
          task={task}
          progress={progress.tasks[task.id]}
          expanded={expandedTaskId === task.id}
          onToggle={() => onToggleTask(task.id)}
          onLaunch={(promptOverride) => onLaunch(task.id, promptOverride)}
          onOpenConversation={onOpenConversation}
          pending={isPending?.(task.id) ?? false}
          assistantId={assistantId}
        />
      ))}
    </Card.Root>
  );
}
