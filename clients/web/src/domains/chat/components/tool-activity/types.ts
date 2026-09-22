/**
 * Shared contract for tool-specific activity renderers (LUM-2999).
 *
 * `ToolDetailBody` owns the Output section most tools share and delegates the
 * body to a renderer chosen by `getToolActivityRenderer`. A renderer that also
 * wants to own how the result is presented (as `skill_load` does, since its
 * "output" *is* the skill body) says so with `output` in the registry, so the
 * generic Output block is suppressed rather than duplicated. Owning the output
 * means owning every reason it can be empty, which is what `ToolOutputBody` is
 * for: a renderer that re-derives those cases will eventually miss one.
 *
 * Raw data is never a renderer's job. `ToolDetailBody` draws the raw input and
 * raw output of every call below whatever the renderer shows, so a renderer
 * cannot leave either out.
 */

import type {
  AnsweredQuestion,
  ToolActivityMetadata,
} from "@vellumai/assistant-api";
import type { ReactNode } from "react";

import type { ToolDetailPayload } from "@/stores/viewer-store";

export interface ToolActivityRendererProps {
  /** The payload the drawer was opened with (snapshot at open time). */
  detail: ToolDetailPayload;
  /**
   * Live result, preferring the streaming store over the open-time snapshot.
   * `undefined` until the call lands.
   */
  result: unknown;
  /**
   * The call's structured result, live like `result`. `undefined` until the
   * call lands, and for history recorded before its tool reported one, so a
   * renderer that reads it keeps a way to show the result without it.
   */
  activityMetadata: ToolActivityMetadata | undefined;
  /** Live streamed output tail while the call runs, when the tool emits one. */
  streamedOutput: string | undefined;
  /**
   * The settled `ask_question` record, live like `activityMetadata`.
   * `undefined` while a prompt is outstanding, and for one that timed out or
   * was aborted, which record no user decision.
   */
  answeredQuestion: AnsweredQuestion | undefined;
  /** Whether the call is still in flight. */
  isRunning: boolean;
  /** Whether the call ended in an error. */
  isError: boolean;
  /** Whether the call was refused, or its confirmation expired unanswered. */
  isDenied: boolean;
  /**
   * Assistant that owns the conversation, threaded to any markdown so
   * workspace file links resolve against the right workspace.
   */
  assistantId?: string | null;
}

/** Registry entry describing how one tool renders in the activity drawer. */
export interface ToolActivityRenderer {
  /** Component rendered in place of the generic name/activity/input block. */
  Component: (props: ToolActivityRendererProps) => ReactNode;
  /**
   * Who presents the result. `shared`: `ToolDetailBody`'s Output section.
   * `own`: this renderer, as a readable view of it, so the raw result is
   * offered underneath. `verbatim`: this renderer, as the raw text itself, so
   * there is no separate raw form to offer.
   */
  output: ToolOutputPresentation;
}

export type ToolOutputPresentation = "shared" | "own" | "verbatim";
