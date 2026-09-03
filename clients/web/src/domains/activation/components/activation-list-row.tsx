/**
 * One task on the Inspiration List, in whichever of the three states the
 * daemon's progress puts it: not started, running, or finished.
 *
 * The row is a `ListRow` plus a slot beneath it. Everything a click could
 * reach (the task's external call to action, the file a finished task
 * produced) lives in that slot rather than in the row's title or subtitle,
 * because `ListRow` renders those inside its own button and a link or a file
 * card nested in a button is neither valid markup nor reachable by keyboard.
 * The slot is indented to the content column so it still reads as part of the
 * row, which is where Figma puts it (`8300:167752`).
 *
 * Muting a finished row is a token swap on the title rather than an opacity
 * on the block (PLAN A22): the mock fades the whole title block, which dims
 * the text against whatever is behind it and lands at a different contrast in
 * each theme.
 */

import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { cn, ListRow } from "@vellumai/design-library";

import {
  EXTERNAL_LINK_CLASS,
  ExternalAnchor,
} from "@/components/external-anchor";
import { LocalFileCard } from "@/components/local-file/local-file-card";
import { localFileKindFromFilename } from "@/components/local-file/local-file-icon";
import { ProcessStatusPill } from "@/components/process-status-pill";
import { useTranslation } from "@/i18n";
import { isElectron } from "@/runtime/is-electron";

import type { ActivationColor, ActivationTask } from "../catalog";
import type { ActivationTaskProgress } from "../hooks/use-activation-progress";

/** Where a row stands: nothing launched, a turn running, or a turn finished. */
type ActivationRowState = "todo" | "working" | "done";

/**
 * The glyph and disc each catalog color resolves to, which are the
 * strong/weak pair of one design-system hue. The mock's discs are those weak
 * tokens exactly, and a token is also what carries the disc into dark, where
 * a tint mixed off the strong colour would sit on the wrong side of the
 * background.
 *
 * The palette has no purple, so purple borrows the nearest hue it does carry
 * rather than introducing a hex the themes would not follow.
 */
const COLOR_TOKENS: Record<ActivationColor, { strong: string; weak: string }> =
  {
    blue: { strong: "--system-info-strong", weak: "--system-info-weak" },
    teal: { strong: "--feed-digest-strong", weak: "--feed-digest-weak" },
    yellow: { strong: "--feed-thread-strong", weak: "--feed-thread-weak" },
    pink: { strong: "--feed-nudge-strong", weak: "--feed-nudge-weak" },
    green: {
      strong: "--system-positive-strong",
      weak: "--system-positive-weak",
    },
    orange: {
      strong: "--system-negative-strong",
      weak: "--system-negative-weak",
    },
    purple: { strong: "--feed-nudge-strong", weak: "--feed-nudge-weak" },
  };

/** The finished disc: a green check, whatever colour the task carries. */
const DONE_COLORS = {
  strong: "--system-positive-strong",
  weak: "--system-positive-weak",
};

/** The state a task's stored progress puts its row in. */
function activationRowState(
  progress: ActivationTaskProgress | undefined,
): ActivationRowState {
  if (progress?.status === "done") {
    return "done";
  }
  if (progress?.status === "started") {
    return "working";
  }
  return "todo";
}

/**
 * The task's glyph in its tinted disc, or the green check that replaces it
 * once the task is finished (PLAN A21).
 */
function ActivationTaskIcon({
  task,
  state,
}: {
  task: ActivationTask;
  state: ActivationRowState;
}) {
  const done = state === "done";
  const { strong, weak } = done ? DONE_COLORS : COLOR_TOKENS[task.color];
  const Glyph = done ? Check : task.icon;
  return (
    <span
      aria-hidden
      className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full"
      style={{ color: `var(${strong})`, backgroundColor: `var(${weak})` }}
    >
      <Glyph className="h-3 w-3" />
    </span>
  );
}

/** The file a finished task produced, when its turn attached one. */
function ActivationArtifactCard({
  artifact,
  assistantId,
}: {
  artifact: ActivationTaskProgress["artifacts"][number];
  assistantId?: string;
}) {
  const filename =
    artifact.workspacePath.split("/").pop() || artifact.displayName;
  return (
    <LocalFileCard
      displayName={artifact.displayName}
      filename={filename}
      sizeBytes={null}
      kind={localFileKindFromFilename(filename)}
      state="ready"
      workspacePath={artifact.workspacePath}
      assistantId={assistantId}
    />
  );
}

export interface ActivationListRowProps {
  task: ActivationTask;
  /** The daemon's record for this task, absent while it is untouched. */
  progress?: ActivationTaskProgress;
  /** True while this row's launch is in flight. */
  pending?: boolean;
  onLaunch: (taskId: string) => void;
  onOpenConversation: (conversationId: string) => void;
  assistantId?: string;
}

export function ActivationListRow({
  task,
  progress,
  pending = false,
  onLaunch,
  onOpenConversation,
  assistantId,
}: ActivationListRowProps) {
  const { t } = useTranslation("activation");
  const state = activationRowState(progress);
  const conversationId = progress?.conversationId ?? null;
  const artifact = state === "done" ? progress?.artifacts[0] : undefined;

  // A launch that has not landed yet reads as Working with nothing to count:
  // the row has already left `todo` and the daemon has no steps for it.
  const showsWorking = state === "working" || pending;

  const activate = () => {
    if (state === "todo") {
      onLaunch(task.id);
      return;
    }
    if (conversationId) {
      onOpenConversation(conversationId);
    }
  };
  const interactive = state === "todo" || conversationId !== null;

  // The download page a task points at is what the desktop app already is, so
  // the call to action only ships where it leads somewhere new.
  const link = task.link && !isElectron() ? task.link : null;
  const extras: ReactNode[] = [];
  if (link) {
    extras.push(
      <ExternalAnchor
        key="link"
        href={link.url}
        className={cn(EXTERNAL_LINK_CLASS, "text-label-medium-default")}
      >
        {link.label}
      </ExternalAnchor>,
    );
  }
  if (artifact) {
    extras.push(
      <ActivationArtifactCard
        key="artifact"
        artifact={artifact}
        assistantId={assistantId}
      />,
    );
  } else if (showsWorking || state === "done") {
    extras.push(
      <ProcessStatusPill
        key="status"
        state={showsWorking ? "working" : "done"}
        label={showsWorking ? t("row.working") : t("row.done")}
        count={
          progress?.stepCount
            ? t("row.steps", { count: progress.stepCount })
            : undefined
        }
      />,
    );
  }

  return (
    <li className="flex flex-col border-b border-[var(--border-base)] last:border-b-0">
      <ListRow
        className={cn(
          "items-start rounded-none px-3 py-4",
          extras.length > 0 && "pb-0",
        )}
        leading={<ActivationTaskIcon task={task} state={state} />}
        title={
          <span
            className={cn(state === "done" && "text-[var(--content-tertiary)]")}
          >
            {task.title}
          </span>
        }
        subtitle={
          <span className="text-label-medium-default leading-[1.45]">
            {task.description}
          </span>
        }
        showChevron={false}
        onClick={interactive ? activate : undefined}
        disabled={pending}
      />
      {extras.length > 0 ? (
        <div className="flex flex-col items-start gap-2 pt-3 pr-3 pb-4 pl-[50px]">
          {extras}
        </div>
      ) : null}
    </li>
  );
}
