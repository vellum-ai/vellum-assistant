import { useTranslation } from "@/i18n";
/**
 * In-chat onboarding card that morphs between two phases:
 *
 * 1. **choice** — Two buttons: "I have something specific" (calls
 *    `onSelectSpecific`) and "Let's chat" (transitions to task selection).
 * 2. **taskSelection** — Multi-select grid of task categories from the
 *    `PRECHAT_TASKS` catalog with a "Continue" submit button.
 *
 * Rendered in the chat transcript after the canned greeting on iOS.
 */

import { MessageSquare } from "lucide-react";
import {
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { TASK_ICONS } from "@/components/prechat-task-icons";
import { PRECHAT_TASKS } from "@/types/prechat-tasks";
import {
  Button,
  Card,
  OptionCard,
  OptionCardGroup,
  Textarea,
} from "@vellumai/design-library";

export interface OnboardingChoiceCardProps {
  onSelectSpecific: () => void;
  onSubmitTasks: (tasks: Set<string>, customText?: string) => void;
}

export function OnboardingChoiceCard({
  onSelectSpecific,
  onSubmitTasks,
}: OnboardingChoiceCardProps): ReactNode {
  const { t } = useTranslation("chat");
  const [phase, setPhase] = useState<"choice" | "taskSelection">("choice");
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(
    new Set<string>(),
  );
  const [otherSelected, setOtherSelected] = useState(false);
  const [otherText, setOtherText] = useState("");
  const otherInputRef = useRef<HTMLTextAreaElement>(null);
  const headingId = useId();

  const toggle = (id: string) => {
    setSelectedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleOther = () => {
    if (otherSelected) {
      setOtherSelected(false);
      setOtherText("");
    } else {
      setOtherSelected(true);
      requestAnimationFrame(() => otherInputRef.current?.focus());
    }
  };

  const hasSelection =
    selectedTasks.size > 0 || (otherSelected && otherText.trim().length > 0);

  return (
    <div
      className="max-w-sm"
      style={{ animation: "fadeInUp 0.3s ease-out both" }}
    >
      <Card>
        {phase === "choice" ? (
          <div className="flex flex-col gap-2">
            <Button
              variant="outlined"
              size="regular"
              fullWidth
              onClick={onSelectSpecific}
            >
              {t("onboardingChoiceCard.specific")}
            </Button>
            <Button
              variant="primary"
              size="regular"
              fullWidth
              onClick={() => setPhase("taskSelection")}
            >
              {t("onboardingChoiceCard.letsChat")}
            </Button>
          </div>
        ) : (
          <div
            className="flex flex-col gap-3"
            style={{ animation: "fadeInUp 0.2s ease-out both" }}
          >
            <div>
              <div
                id={headingId}
                className="text-body-medium-default text-[color:var(--content-default)]"
              >
                {t("onboardingChoiceCard.helpWithHeading")}
              </div>
              <div className="mt-0.5 text-label-small-default text-[color:var(--content-tertiary)]">
                {t("onboardingChoiceCard.selectAll")}
              </div>
            </div>

            <OptionCardGroup
              selectionMode="multiple"
              columns={2}
              aria-labelledby={headingId}
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
                    onSelect={() => toggle(task.id)}
                  />
                );
              })}

              <OptionCard
                className="col-span-2"
                orientation="vertical"
                size="compact"
                markPosition="end"
                leading={<MessageSquare className="h-4 w-4" />}
                title={t("onboardingChoiceCard.other")}
                description={t("onboardingChoiceCard.somethingElse")}
                selected={otherSelected}
                onSelect={toggleOther}
              />
            </OptionCardGroup>

            {/* The free-text field sits under the grid rather than inside the
                "Other" tile: a tile is a real button, and a button cannot host
                a textarea. */}
            {otherSelected && (
              <Textarea
                ref={otherInputRef}
                fullWidth
                rows={1}
                value={otherText}
                onChange={(e) => setOtherText(e.target.value)}
                aria-label={t("onboardingChoiceCard.other")}
                placeholder={t("onboardingChoiceCard.otherPlaceholder")}
                className="min-h-0 resize-none overflow-hidden"
                style={{ fieldSizing: "content" } as CSSProperties}
              />
            )}

            <Button
              variant="primary"
              size="regular"
              fullWidth
              disabled={!hasSelection}
              onClick={() =>
                onSubmitTasks(
                  selectedTasks,
                  otherSelected ? otherText.trim() : undefined,
                )
              }
            >
              {t("onboardingChoiceCard.continue")}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
