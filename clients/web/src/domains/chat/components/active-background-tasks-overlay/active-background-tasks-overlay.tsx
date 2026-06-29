import { ActiveOverlayShell } from "@/domains/chat/components/active-overlay-shell";
import { ActiveBackgroundTasksPill } from "@/domains/chat/components/active-background-tasks-overlay/active-background-tasks-pill";
import { BackgroundTaskInlineProgressCard } from "@/domains/chat/components/background-task-inline-card/background-task-inline-progress-card";

export interface ActiveBackgroundTasksOverlayProps {
  taskIds: string[];
  onTaskClick?: (id: string) => void;
}

export function ActiveBackgroundTasksOverlay({
  taskIds,
  onTaskClick,
}: ActiveBackgroundTasksOverlayProps) {
  if (taskIds.length === 0) return null;

  return (
    <ActiveOverlayShell
      testId="active-background-tasks-overlay"
      title={`${taskIds.length} Active Command${
        taskIds.length === 1 ? "" : "s"
      }`}
      renderPill={({ expanded, onToggle }) => (
        <ActiveBackgroundTasksPill
          taskIds={taskIds}
          expanded={expanded}
          onToggle={onToggle}
        />
      )}
    >
      {({ close }) =>
        taskIds.map((id) => (
          <BackgroundTaskInlineProgressCard
            key={id}
            id={id}
            // Opening drills into the detail panel and dismisses the dropdown
            // so the two layers stop competing for width. Stopping (the card's
            // own button) keeps it open.
            onClick={
              onTaskClick
                ? (taskId) => {
                    onTaskClick(taskId);
                    close();
                  }
                : undefined
            }
          />
        ))
      }
    </ActiveOverlayShell>
  );
}
