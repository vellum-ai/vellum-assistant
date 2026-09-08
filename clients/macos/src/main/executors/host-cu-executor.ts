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
  type CoachmarkRefusal,
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

const UNSHARED =
  "Nothing is being shared, so there is no surface to point at. Ask the user to share their screen from the call first.";

/**
 * What a turn that does not own the call is told.
 *
 * Named as the boundary it is rather than as a fault: the surface belongs to
 * another conversation, which is not a thing this one can fix by trying
 * again, and an assistant told merely that it failed would.
 */
const NOT_THIS_CALL =
  "The shared screen belongs to another conversation, so this one cannot point at it. Only the call being shown the screen can draw on it.";

/**
 * What a turn holding a picture of the wrong surface is told.
 *
 * Actionable on its own: the user is still sharing, so asking them to share
 * again would be asking for something they already did. What this turn needs
 * is another look at what they are showing now.
 */
const STALE_SURFACE =
  "The user has moved the share to another screen or window since the picture you measured against, so those coordinates no longer describe what they are showing. Wait for a fresh frame of the new surface and point again.";

/** What the assistant is told for each way a set of marks can be refused. */
const REFUSALS: Record<CoachmarkRefusal, string> = {
  unshared: UNSHARED,
  "not-this-call": NOT_THIS_CALL,
  "stale-surface": STALE_SURFACE,
};

/**
 * What draws the marks, handed in rather than reached for.
 *
 * The surface lives in the window layer and this is the host proxy: an
 * executor that imported its way into the windows would be the transport
 * depending on the thing being transported to. The app wires the two
 * together (`host-proxy-adapter.ts`), which is also what lets these paths be
 * exercised without a window server.
 *
 * The conversation goes with the marks because a mark carries no identity of
 * its own: it names a rectangle, and the surface it would land on belongs to
 * whichever call is being shown the screen. See `showCompanionCoachmarks`,
 * which answers `null` for marks that stand and names its refusal otherwise.
 */
export type CoachmarkPainter = (
  marks: readonly CompanionCoachmark[],
  conversationId?: string,
) => CoachmarkRefusal | null;

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
    // The conversation the daemon addressed this request to, which is what
    // lets the window layer tell the call's own turn from any other running
    // for the same user. Absent on a daemon too old to send it, which the
    // painter reads as a claim it cannot check.
    const conversationId = message.conversationId;
    const refusal = this.paint(
      marks,
      typeof conversationId === "string" ? conversationId : undefined,
    );
    void poster.postCuResult({
      requestId,
      ...(refusal === null
        ? { executionResult: PLACED(marks.length) }
        : { executionError: REFUSALS[refusal] }),
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
      supportsWindowCapture: true,
      resolveHelper: helper ? () => helper : getSharedCuHelper,
    }),
    showCoachmarks,
  );
}
