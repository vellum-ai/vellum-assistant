import { MessageSquare } from "lucide-react";
import { useId, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "@/i18n";

import {
  Button,
  OptionCard,
  OptionCardGroup,
  Textarea,
} from "@vellumai/design-library";

import { TASK_ICONS } from "@/components/prechat-task-icons";
import type { Surface } from "@/domains/chat/types/types";
import { PRECHAT_TASKS } from "@/types/prechat-tasks";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskPreferencesSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Multi-select task-category grid surface. Renders the same task tiles as
 * `OnboardingChoiceCard`'s task-selection phase, but presented inline in the
 * chat transcript as a daemon-driven surface that the LLM can spawn from a
 * tool call. Submits selections back through `onAction("submit", { tasks,
 * customText })`.
 */
export function TaskPreferencesSurface({
  surface,
  onAction,
}: TaskPreferencesSurfaceProps) {
  const { t } = useTranslation("chat");
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set());
  const [otherSelected, setOtherSelected] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();

  if (surface.completed) {
    return null;
  }

  const toggleTask = (taskId: string) => {
    setSelectedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const toggleOther = () => {
    setOtherSelected((prev) => {
      const next = !prev;
      if (next) {
        // Focus textarea after React re-renders with it visible.
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
        });
      } else {
        setOtherText("");
      }
      return next;
    });
  };

  const canSubmit =
    selectedTasks.size > 0 || (otherSelected && otherText.trim().length > 0);

  const handleSubmit = async () => {
    if (!canSubmit || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    try {
      await onAction(surface.surfaceId, "submit", {
        tasks: Array.from(selectedTasks),
        customText: otherText.trim() || undefined,
      });
    } catch {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--border-element)] bg-[var(--surface-overlay)] p-4">
      <div className="flex flex-col gap-1">
        <div
          id={titleId}
          className="text-body-medium-default text-[var(--content-default)]"
        >
          {surface.title ?? t("taskPreferencesSurface.defaultTitle")}
        </div>
        <div className="text-label-small-default text-[color:var(--content-tertiary)]">
          {t("taskPreferencesSurface.selectAll")}
        </div>
      </div>

      <OptionCardGroup
        selectionMode="multiple"
        columns={2}
        aria-labelledby={titleId}
      >
        {PRECHAT_TASKS.map((task) => {
          const Icon = TASK_ICONS[task.iconKey];
          return (
            <OptionCard
              key={task.id}
              orientation="vertical"
              size="compact"
              markPosition="end"
              leading={Icon ? <Icon className="h-4 w-4" /> : undefined}
              title={task.label}
              description={task.sublabel}
              selected={selectedTasks.has(task.id)}
              onSelect={() => toggleTask(task.id)}
            />
          );
        })}

        <OptionCard
          className="col-span-2"
          markPosition="end"
          leading={<MessageSquare className="h-4 w-4" />}
          title={t("taskPreferencesSurface.other")}
          description={t("taskPreferencesSurface.somethingElse")}
          selected={otherSelected}
          onSelect={toggleOther}
        />
      </OptionCardGroup>

      {/* The free-text field sits under the grid rather than inside the
          "Other" tile: a tile is a real button, and a button cannot host a
          textarea. */}
      {otherSelected && (
        <Textarea
          ref={textareaRef}
          fullWidth
          rows={1}
          value={otherText}
          onChange={(e) => setOtherText(e.target.value)}
          aria-label={t("taskPreferencesSurface.other")}
          placeholder={t("taskPreferencesSurface.otherPlaceholder")}
          className="min-h-0 resize-none overflow-hidden"
          style={{ fieldSizing: "content" } as CSSProperties}
        />
      )}

      <Button
        variant="primary"
        size="regular"
        fullWidth
        disabled={!canSubmit || isSubmitting}
        onClick={handleSubmit}
      >
        {t("taskPreferencesSurface.continue")}
      </Button>
    </div>
  );
}
