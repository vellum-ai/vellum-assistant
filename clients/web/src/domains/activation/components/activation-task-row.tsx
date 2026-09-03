/**
 * One checklist task, in whichever of its three states the daemon says it is
 * (Figma: New-App `8300:168063` expanded, `8300:168080` collapsed,
 * `8300:166573` working, `8300:166806` and `8300:166819` done).
 *
 * The row is a `ListRow` plus a body underneath it. The body sits outside the
 * row's own interactive area on purpose: a chip, a text field, a send button
 * and a file card are all controls, and nesting them inside the row's button
 * would leave every one of them unreachable.
 *
 * Which body shows follows the task's status rather than any local state. A
 * `todo` row opens and closes; once launched it stops opening and reads as a
 * way into the conversation doing the work, because there is nothing left to
 * fill in and the interesting part has moved into that thread.
 *
 * Presentational: every action is a callback and every fact is a prop, so the
 * modal and the list page render the same row against the same progress
 * without either owning the other's wiring.
 */

import { useState, type ReactNode } from "react";
import { ArrowUp } from "lucide-react";

import {
  Button,
  cn,
  Input,
  ListRow,
  Typography,
} from "@vellumai/design-library";

import { ConversationStarterChip } from "@/components/conversation-starter-chip";
import {
  ExternalAnchor,
  EXTERNAL_LINK_CLASS,
} from "@/components/external-anchor";
import { LocalFileCard } from "@/components/local-file/local-file-card";
import { artifactFileCardProps } from "@/components/local-file/workspace-artifact";
import { ProcessStatusPill } from "@/components/process-status-pill";
import { useTranslation } from "@/i18n";
import { isElectron } from "@/runtime/is-electron";

import type { ActivationTask } from "../catalog";
import type { ActivationTaskProgress } from "../hooks/use-activation-progress";
import { ActivationTaskIcon } from "./activation-task-icon";

/** What the row shows, derived from the daemon's record for the task. */
export type ActivationRowStatus = "todo" | "working" | "done";

export function activationRowStatus(
  progress: ActivationTaskProgress | null | undefined,
): ActivationRowStatus {
  if (progress?.status === "done") {
    return "done";
  }
  if (progress?.status === "started") {
    return "working";
  }
  return "todo";
}

/**
 * The body's left inset, lining it up with the row's title rather than the
 * row's edge: `ListRow` insets itself by 8px, then leads with the task icon's
 * 26px circle and a 12px gap.
 */
const BODY_INSET = "pl-[46px] pr-2";

export interface ActivationTaskRowProps {
  task: ActivationTask;
  /** The daemon's record for this task, when it has one. */
  progress?: ActivationTaskProgress | null;
  /** Whether the todo body is open. Ignored once the task has been launched. */
  expanded?: boolean;
  /** Open or close the todo body. */
  onToggle?: () => void;
  /** Launch the task. `promptOverride` carries whatever the Custom field holds. */
  onLaunch?: (promptOverride?: string) => void;
  /** Open the conversation a launched task runs in. */
  onOpenConversation?: (conversationId: string) => void;
  /**
   * True while this row's own launch is in flight. Per row rather than per
   * modal: launching one task must not lock the rest, and a row has to stay
   * locked until its own launch settles however many others start meanwhile.
   */
  pending?: boolean;
  /** Owns the artifact card's workspace links. */
  assistantId?: string;
  className?: string;
}

export function ActivationTaskRow({
  task,
  progress,
  expanded = false,
  onToggle,
  onLaunch,
  onOpenConversation,
  pending = false,
  assistantId,
  className,
}: ActivationTaskRowProps): ReactNode {
  const { t } = useTranslation("activation");
  const [custom, setCustom] = useState("");
  const status = activationRowStatus(progress);
  const done = status === "done";
  const conversationId = progress?.conversationId;
  const customId = `activation-custom-${task.id}`;

  const steps =
    progress?.stepCount != null
      ? t("row.steps", { count: progress.stepCount })
      : undefined;

  const activate = (): void => {
    if (status === "todo") {
      onToggle?.();
      return;
    }
    if (conversationId) {
      onOpenConversation?.(conversationId);
    }
  };

  const submitCustom = (): void => {
    const typed = custom.trim();
    if (typed.length === 0 || pending) {
      return;
    }
    onLaunch?.(typed);
  };

  const artifact = done ? progress?.artifacts[0] : undefined;
  // The link points off to the web, and inside the desktop app the web page it
  // points at is a download page for the app the user is already in. Read the
  // platform axis, never the viewport (docs/PLATFORM_ADAPTATION.md).
  const link = task.link !== undefined && !isElectron() ? task.link : undefined;

  let body: ReactNode = null;
  if (status === "working") {
    body = (
      <ProcessStatusPill
        state="working"
        label={t("row.working")}
        count={steps}
      />
    );
  } else if (done) {
    body = artifact ? (
      <LocalFileCard {...artifactFileCardProps(artifact, assistantId)} />
    ) : (
      <ProcessStatusPill state="done" label={t("row.done")} count={steps} />
    );
  } else if (expanded) {
    body = (
      <div className="flex w-full flex-col items-start gap-3">
        {link ? (
          <ExternalAnchor
            href={link.url}
            className={cn(EXTERNAL_LINK_CLASS, "text-label-medium-default")}
          >
            {link.label}
          </ExternalAnchor>
        ) : null}
        <ConversationStarterChip
          label={task.chip}
          disabled={pending}
          onSelect={() => onLaunch?.()}
          className={cn(
            // A pill that hugs its words, not the dock's full-width card.
            "min-h-0 w-auto rounded-[var(--radius-pill)] px-1.5 py-1",
            "text-label-medium-default sm:text-label-medium-default",
            "bg-[var(--feed-digest-weak)] [--vbtn-fg:var(--feed-digest-strong)]",
          )}
        />
        <div className="flex w-full flex-col gap-1">
          <Typography
            as="label"
            variant="label-medium-default"
            htmlFor={customId}
            className="text-[var(--content-secondary)]"
          >
            {t("row.customLabel")}
          </Typography>
          <div className="relative flex w-full items-center">
            <Input
              id={customId}
              fullWidth
              value={custom}
              placeholder={t("row.customPlaceholder")}
              disabled={pending}
              onChange={(event) => setCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitCustom();
                }
              }}
              className="pr-11"
            />
            {/* Floats over the field's right edge, as in the mock: the field
                runs full width underneath it. */}
            <Button
              variant="primary"
              size="compact"
              iconOnly={<ArrowUp />}
              aria-label={t("row.send")}
              disabled={pending || custom.trim().length === 0}
              onClick={submitCustom}
              className="absolute right-1.5 h-7 w-7 rounded-[7px]"
            />
          </div>
        </div>
      </div>
    );
  }

  const mutedText = done ? "text-[var(--content-tertiary)]" : undefined;
  const interactive = status === "todo" || conversationId !== undefined;

  return (
    <div className={cn("py-1", className)}>
      <ListRow
        leading={
          <ActivationTaskIcon
            icon={task.icon}
            color={task.color}
            state={done ? "done" : "todo"}
          />
        }
        title={<span className={mutedText}>{task.title}</span>}
        subtitle={
          // `ListRow` sets the subtitle a rung lower than the mock; the row's
          // descriptions are full sentences and need the 11px step.
          <span className={cn("text-label-medium-default leading-normal", mutedText)}>
            {task.description}
          </span>
        }
        showChevron={false}
        onClick={interactive ? activate : undefined}
        contentAriaLabel={
          status === "todo"
            ? undefined
            : t("row.openTask", { title: task.title })
        }
      />
      {body !== null ? (
        <div className={cn("flex flex-col items-start gap-2 pb-2", BODY_INSET)}>
          {body}
        </div>
      ) : null}
    </div>
  );
}
