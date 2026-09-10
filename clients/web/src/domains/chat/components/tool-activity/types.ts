/**
 * Shared contract for tool-specific activity renderers (LUM-2999).
 *
 * `ToolDetailBody` owns the Output section most tools share and delegates the
 * body to a renderer chosen by `getToolActivityRenderer`. A renderer that also
 * wants to own how the result is presented (as `skill_load` does, since its
 * "output" *is* the skill body) sets `ownsOutput` in the registry so the
 * generic Output block is suppressed rather than duplicated. Owning the output
 * means owning every reason it can be empty, which is what `ToolOutputBody` is
 * for: a renderer that re-derives those cases will eventually miss one.
 */

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
  /** Live streamed output tail while the call runs, when the tool emits one. */
  streamedOutput: string | undefined;
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
   * When true, `ToolDetailBody` suppresses its generic Output section because
   * this renderer already presents the result itself.
   */
  ownsOutput: boolean;
}
