/**
 * macOS binding of the shared computer-use host-proxy executor: it resolves the
 * mac-helper sidecar as the `cu.perform` transport.
 *
 * One tool never reaches the helper. `computer_use_point_at` draws on the
 * frame around the surface a call is being shown, and that frame is a window
 * this process opened: the helper has no idea it exists. So the request is
 * answered here and everything else is forwarded, which keeps the assistant's
 * one path to this machine the path it already has.
 */

import { createCuHelperProxyExecutor } from "@vellumai/electron-desktop/host-proxy/cu-executor";
import type { CuHelperClient } from "@vellumai/electron-desktop/host-proxy/helper-proxy-executor";
import type { HostProxyPoster } from "@vellumai/electron-desktop/host-proxy/poster";
import type { HostProxyExecutor } from "@vellumai/electron-desktop/host-proxy/router";
import type { HostProxySseMessage } from "@vellumai/electron-desktop/host-proxy/sse";
import {
  companionCoachmarkSchema,
  COMPANION_COACHMARK_MAX,
  type CompanionCoachmark,
} from "@vellumai/ipc-contract";
import { z } from "zod";

import log from "../logger";
import { getSharedCuHelper } from "../sidecar/shared-cu-helper";

/** The one tool answered here rather than by the helper. */
export const POINT_AT_TOOL = "computer_use_point_at";

/**
 * What the assistant sends: the whole set of marks, in fractions of the
 * surface the call is being shown.
 *
 * The set rather than one mark, for the reason the channel from the pill
 * takes a set: what is being pointed at is one thought, and a sender that
 * could add to it would be a sender owing a call to take the rest down. An
 * empty list is how it says nothing.
 */
const POINT_AT_INPUT = z.object({
  marks: z.array(companionCoachmarkSchema).max(COMPANION_COACHMARK_MAX),
});

/**
 * What the assistant is told, which is not the same as what a press from the
 * pill learns.
 *
 * A refusal has to be legible: the assistant is not looking at the screen it
 * asked to draw on, and one that believed a mark it never placed would talk
 * the user through a ring that is not there.
 */
const PLACED = (count: number): string =>
  count === 0
    ? "Marks cleared."
    : `Drew ${count} mark${count === 1 ? "" : "s"} on the shared surface.`;

const REFUSED =
  "Nothing is being shared, so there is no surface to point at. Ask the user to share their screen from the call first.";

/**
 * What draws the marks, handed in rather than reached for.
 *
 * The surface lives in the window layer and this is the host proxy: an
 * executor that imported its way into the windows would be the transport
 * depending on the thing being transported to. The app wires the two
 * together (`host-proxy-adapter.ts`), which is also what lets these paths be
 * exercised without a window server.
 *
 * The boolean is whether the marks stand. See `showCompanionCoachmarks`.
 */
export type CoachmarkPainter = (
  marks: readonly CompanionCoachmark[],
) => boolean;

const UNWIRED =
  "This client cannot draw on the screen: no coachmark painter is wired.";

/**
 * The computer-use executor, with the pointing tool answered in this process.
 *
 * Delegation rather than a branch inside the shared executor: the shared one
 * is the transport to the native helper and is used by every desktop client,
 * and the frame it would be drawing on is this client's alone.
 */
class PointAtExecutor implements HostProxyExecutor {
  constructor(
    private readonly helper: HostProxyExecutor,
    private readonly paint: CoachmarkPainter | undefined,
  ) {}

  handleRequest(message: HostProxySseMessage, poster: HostProxyPoster): void {
    if (message.toolName !== POINT_AT_TOOL) {
      this.helper.handleRequest(message, poster);
      return;
    }
    const requestId = message.requestId as string | undefined;
    if (!requestId) {
      log.warn("[host-cu-executor] point_at message missing requestId");
      return;
    }
    const parsed = POINT_AT_INPUT.safeParse(message.input ?? {});
    if (!parsed.success) {
      void poster.postCuResult({
        requestId,
        executionError: `Invalid marks: ${parsed.error.issues[0]?.message ?? "unreadable"}. Each mark is {x, y, width, height} in fractions of the shared surface from 0 to 1, with an optional short caption.`,
      });
      return;
    }
    if (!this.paint) {
      void poster.postCuResult({ requestId, executionError: UNWIRED });
      return;
    }
    const { marks } = parsed.data;
    const placed = this.paint(marks);
    void poster.postCuResult({
      requestId,
      ...(placed
        ? { executionResult: PLACED(marks.length) }
        : { executionError: REFUSED }),
    });
  }

  /**
   * Forwarded whatever the tool was. A cancel names a request rather than a
   * tool, and the pointing this executor answers is done before a cancel
   * could reach it, so the only cancel worth recording is the helper's.
   */
  handleCancel(message: HostProxySseMessage, poster: HostProxyPoster): void {
    this.helper.handleCancel(message, poster);
  }
}

export interface HostCuExecutorDeps {
  helper?: CuHelperClient;
  /** What draws the marks. Absent means this client answers that it cannot. */
  showCoachmarks?: CoachmarkPainter;
}

export function createHostCuExecutor(
  deps: HostCuExecutorDeps = {},
): HostProxyExecutor {
  const { helper, showCoachmarks } = deps;
  return new PointAtExecutor(
    createCuHelperProxyExecutor({
      logger: log,
      resolveHelper: helper ? () => helper : getSharedCuHelper,
    }),
    showCoachmarks,
  );
}
