/**
 * The activation welcome modal (Figma: New-App `8300:168003`, and the
 * all-completed variant `8300:166860`).
 *
 * The modal stays open while tasks run. That is the whole point of the
 * surface: a launched row collapses to Working, the next unstarted row opens
 * with its chip ready, and the user kicks off two or three background
 * conversations in one sitting instead of one per visit.
 *
 * Progress is never copied into local state. Which rows are working or done,
 * and their step counts, arrive from the daemon on every render, so three
 * background conversations report themselves without this component tracking
 * any of them. It is a required prop rather than a read of its own, so there
 * is no state in which this draws an actionable row against progress it has
 * not seen; the controller holds the modal back until the read lands.
 *
 * The header is full bleed and inverts against the body, which one set of
 * tokens cannot express: in light the band is the primary ink with inset text
 * on it, and in dark that ink is the page itself, so the band becomes the
 * sunken surface with ordinary content colours (PLAN A16/A25).
 *
 * The shell is a modal on a pointer surface and a bottom sheet on a phone,
 * chosen by the design library's touch-surface signal rather than by width.
 *
 * There is no close glyph, matching the mock. Escape and a click outside both
 * dismiss, and each variant carries a keyboard-reachable way out of its own:
 * "Do it Later" on the welcome modal, "Show me the full list" on the
 * celebration.
 */

import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import {
  BottomSheet,
  Button,
  cn,
  Modal,
  toast,
  Typography,
  useTouchSurface,
} from "@vellumai/design-library";

import { activationProgressGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { useTranslation } from "@/i18n";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { publicAsset } from "@/utils/public-asset";
import { routes } from "@/utils/routes";

import { useActivationUiStore } from "../activation-ui-store";
import { useAvailableActivationList } from "../capabilities";
import type { ActivationTask } from "../catalog";
import type { ActivationProgress } from "../hooks/use-activation-progress";
import { useLaunchActivationTask } from "../hooks/use-launch-activation-task";
import { ActivationTaskList } from "./activation-task-list";
import { activationRowStatus } from "./activation-task-row";

/**
 * `welcome` is the first-run modal with its dismiss button; `all-done` is the
 * celebration, which ends the checklist and so offers the full list instead of
 * a way to put it off.
 */
export type ActivationModalVariant = "welcome" | "all-done";

export interface ActivationWelcomeModalProps {
  open: boolean;
  /** The list the rows come from, already resolved by the visibility gate. */
  listId: string;
  progress: ActivationProgress;
  variant: ActivationModalVariant;
  /** Close the modal. The caller records the dismissal with the daemon. */
  onDismiss: () => void;
}

/** The first task in `tasks` the daemon holds no started or done record for. */
function firstTodoTaskId(
  tasks: ActivationTask[],
  progress: ActivationProgress,
  skipTaskId?: string,
): string | null {
  const next = tasks.find(
    (task) =>
      task.id !== skipTaskId &&
      activationRowStatus(progress.tasks[task.id]) === "todo",
  );
  return next?.id ?? null;
}

/** Body padding, kept in one place so the sheet and the modal agree. */
const PANEL_INSET = "px-4";

export function ActivationWelcomeModal({
  open,
  listId,
  progress,
  variant,
  onDismiss,
}: ActivationWelcomeModalProps): ReactNode {
  const { t } = useTranslation("activation");
  const navigate = useNavigate();
  const touchSurface = useTouchSurface();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  // Filtered, so a row whose prerequisite is missing is never offered, seeded
  // as the open one, or counted by Show More (`../capabilities.ts`).
  const { starters, items } = useAvailableActivationList(listId);
  const { launch, isPending } = useLaunchActivationTask(listId);
  const queryClient = useQueryClient();
  // Launch completions read the pending set as it is when they settle, not as
  // it was when the launch began.
  const isPendingRef = useRef(isPending);
  useEffect(() => {
    isPendingRef.current = isPending;
  }, [isPending]);

  const expandedTaskId = useActivationUiStore.use.expandedTaskId();
  const setExpandedTaskId = useActivationUiStore.use.setExpandedTaskId();
  const toggleTask = useActivationUiStore.use.toggleTask();
  const showMore = useActivationUiStore.use.showMore();
  const setShowMore = useActivationUiStore.use.setShowMore();

  const tasks = useMemo(
    () => (showMore ? [...starters, ...items] : starters),
    [items, showMore, starters],
  );

  /**
   * Open the first unstarted row when the modal appears, once. Re-seeding on
   * every progress change would fight the user: a row they closed, or one they
   * just launched, would pull another open under the cursor.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current) {
      return;
    }
    seeded.current = true;
    setExpandedTaskId(firstTodoTaskId(starters, progress));
  }, [open, starters, progress, setExpandedTaskId]);

  const handleOpenConversation = useCallback(
    (conversationId: string) => {
      onDismiss();
      navigateToConversation(navigate, conversationId);
    },
    [navigate, onDismiss],
  );

  const handleLaunch = useCallback(
    (taskId: string, promptOverride?: string) => {
      void launch(taskId, promptOverride).then((result) => {
        if (result.ok) {
          // The accordion moves on only once the daemon holds the launch: a
          // refused row has to stay where the user left it, and a row they
          // opened while the launch was out is theirs rather than this
          // launch's to overwrite.
          if (useActivationUiStore.getState().expandedTaskId === taskId) {
            // Progress and the pending set as they stand now: a row launched
            // meanwhile is neither todo nor a candidate to open.
            const current =
              (assistantId
                ? queryClient.getQueryData<ActivationProgress>(
                    activationProgressGetQueryKey({
                      path: { assistant_id: assistantId },
                    }),
                  )
                : undefined) ?? progress;
            const candidates = tasks.filter(
              (task) => !isPendingRef.current(task.id),
            );
            setExpandedTaskId(firstTodoTaskId(candidates, current, taskId));
          }
          return;
        }
        if (!result.error) {
          return;
        }
        // A failure that still names a conversation got as far as linking one,
        // so the work may be recoverable by opening it. A failure without one
        // has nothing to open, and the row stays where it was.
        toast.error(result.error, {
          ...(result.conversationId
            ? {
                action: {
                  label: t("launch.openConversation"),
                  onClick: () => handleOpenConversation(result.conversationId!),
                },
              }
            : {}),
        });
      });
    },
    [
      handleOpenConversation,
      launch,
      progress,
      setExpandedTaskId,
      t,
      tasks,
      assistantId,
      queryClient,
    ],
  );

  const handleShowFullList = useCallback(() => {
    onDismiss();
    void navigate(routes.activationList);
  }, [navigate, onDismiss]);

  const disclosure =
    variant === "all-done" ? (
      <Button
        variant="link"
        rightIcon={<ChevronRight className="h-4 w-4" />}
        className="text-body-medium-default [--vbtn-fg:var(--content-tertiary)]"
        onClick={handleShowFullList}
      >
        {t("welcome.showFullList")}
      </Button>
    ) : showMore ? null : (
      <Button
        variant="link"
        rightIcon={<ChevronDown className="h-4 w-4" />}
        className="text-body-medium-default [--vbtn-fg:var(--content-tertiary)]"
        onClick={() => setShowMore(true)}
      >
        {t("welcome.showMore", { count: items.length })}
      </Button>
    );

  const body = (
    <>
      <ActivationTaskList
        tasks={tasks}
        progress={progress}
        expandedTaskId={expandedTaskId}
        onToggleTask={toggleTask}
        onLaunch={handleLaunch}
        onOpenConversation={handleOpenConversation}
        isPending={isPending}
        assistantId={assistantId ?? undefined}
      />
      {disclosure ? <div className="pt-6">{disclosure}</div> : null}
    </>
  );

  const footer =
    variant === "welcome" ? (
      <div className={cn("flex shrink-0 justify-end pt-4", PANEL_INSET)}>
        <Button variant="outlined" onClick={onDismiss}>
          {t("welcome.later")}
        </Button>
      </div>
    ) : null;

  const dismissOnClose = (next: boolean): void => {
    if (!next) {
      onDismiss();
    }
  };

  if (touchSurface) {
    return (
      <BottomSheet.Root open={open} onOpenChange={dismissOnClose}>
        <BottomSheet.Content
          padded={false}
          className="max-h-[85dvh] overflow-hidden"
        >
          <ActivationWelcomeHeader sheet />
          <div
            className={cn("min-h-0 flex-1 overflow-y-auto pt-6", PANEL_INSET)}
          >
            {body}
          </div>
          {footer}
          <div className="h-[calc(16px+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))] shrink-0" />
        </BottomSheet.Content>
      </BottomSheet.Root>
    );
  }

  return (
    <Modal.Root open={open} onOpenChange={dismissOnClose}>
      <Modal.Content
        size="sm"
        hideCloseButton
        className="max-w-[440px] overflow-hidden"
      >
        <ActivationWelcomeHeader sheet={false} />
        <div className={cn("min-h-0 flex-1 overflow-y-auto pt-6", PANEL_INSET)}>
          {body}
        </div>
        {footer}
        <div className="h-4 shrink-0" />
      </Modal.Content>
    </Modal.Root>
  );
}

/**
 * The full-bleed band: the serif greeting, the two-line subtitle, and the
 * mascot strip the band's bottom edge cuts off.
 *
 * The title element differs by shell because each dialog primitive owns its
 * own, and Radix needs the one belonging to the dialog it is inside.
 */
function ActivationWelcomeHeader({ sheet }: { sheet: boolean }): ReactNode {
  const { t } = useTranslation("activation");
  const titleClassName = cn(
    "w-full justify-center px-4 text-center text-[32px] tracking-[0.02em]",
    "text-[var(--content-inset)] dark:text-[var(--content-emphasised)]",
  );
  const titleStyle = { fontFamily: "var(--font-serif)" };

  return (
    <div
      className={cn(
        "flex shrink-0 flex-col items-center gap-4 overflow-hidden pt-8",
        "bg-[var(--primary-base)] dark:bg-[var(--surface-sunken)]",
      )}
    >
      {sheet ? (
        <BottomSheet.Title className={titleClassName} style={titleStyle}>
          {t("welcome.title")}
        </BottomSheet.Title>
      ) : (
        <Modal.Title className={titleClassName} style={titleStyle}>
          {t("welcome.title")}
        </Modal.Title>
      )}
      <Typography
        as="p"
        variant="body-medium-lighter"
        className={cn(
          "max-w-[392px] px-4 text-center leading-[22px]",
          "text-[color-mix(in_srgb,var(--content-inset)_80%,transparent)]",
          "dark:text-[var(--content-secondary)]",
        )}
      >
        {t("welcome.subtitle")}
      </Typography>
      {/* Exported at the size the band clips it to, so the characters read as
          standing behind the band's bottom edge. */}
      <img
        src={publicAsset("/activation-mascots.svg")}
        alt=""
        aria-hidden="true"
        width={322}
        height={57}
        className="h-[57px] max-w-full shrink-0"
      />
    </div>
  );
}
