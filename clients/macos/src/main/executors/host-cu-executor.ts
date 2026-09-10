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
  COMPANION_COACHMARK_CAPTION_MAX,
  COMPANION_COACHMARK_MAX,
  type CoachmarkRefusal,
  type CoachmarkRequest,
  type CoachmarkResult,
  type CoachmarkUnresolved,
} from "@vellumai/ipc-contract";
import { z } from "zod";

import log from "../logger";
import { getSharedCuHelper } from "../sidecar/shared-cu-helper";

/** The one tool answered here rather than by the helper. */
export const POINT_AT_TOOL = "computer_use_point_at";

/**
 * How long a name may be.
 *
 * Generous next to any real control's label, since a label is free to be a
 * sentence and some are. Bounded at all so a paragraph cannot be sent as a
 * name.
 */
const TARGET_MAX = 120;

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
  marks: z
    .array(
      z.union([
        z.object({
          target: z.string().min(1).max(TARGET_MAX),
          caption: z.string().max(COMPANION_COACHMARK_CAPTION_MAX).optional(),
        }),
        z.object({
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          width: z.number().min(0).max(1),
          height: z.number().min(0).max(1),
          caption: z.string().max(COMPANION_COACHMARK_CAPTION_MAX).optional(),
        }),
      ]),
    )
    .max(COMPANION_COACHMARK_MAX),
});

/**
 * What the assistant is told, which is not the same as what a press from the
 * pill learns.
 *
 * A refusal has to be legible: the assistant is not looking at the screen it
 * asked to draw on, and one that believed a mark it never placed would talk
 * the user through a ring that is not there.
 */
const PLACED = (marks: CoachmarkResult & { kind: "placed" }): string => {
  if (marks.marks.length === 0) {
    return "Marks cleared.";
  }
  const drawn = marks.marks
    .map((mark) => {
      if (mark.kind === "region") {
        return `a ring over ${percent(mark.x)},${percent(mark.y)} to ${percent(
          mark.x + mark.width,
        )},${percent(mark.y + mark.height)}`;
      }
      const at = `${percent(mark.x)},${percent(mark.y)}`;
      return mark.matched === undefined
        ? `an arrow at ${at}`
        : `an arrow at "${mark.matched}", ${at}`;
    })
    .join("; ");
  return `Drew ${marks.marks.length} mark${
    marks.marks.length === 1 ? "" : "s"
  } on the shared surface: ${drawn}. Coordinates are fractions of the surface.`;
};

/** A fraction as the percentage a person would say, for the report above. */
const percent = (fraction: number): string =>
  `${Math.round(fraction * 1000) / 10}%`;

/**
 * How many labels are worth naming back.
 *
 * A surface can carry a hundred, and a list that long is not an answer, it is
 * the tree again. Enough to recognise the thing that was meant, and the count
 * says how many were not named.
 */
const CANDIDATES_SHOWN = 24;

/**
 * What a named control that did not resolve is answered with.
 *
 * The labels come back because the whole point of naming rather than guessing
 * is that a miss is recoverable: told what is actually on the surface, the
 * next attempt can name one of those, or say out loud that the thing is not
 * there. Told only "not found", it would guess coordinates again.
 */
const UNRESOLVED = (unresolved: CoachmarkUnresolved): string => {
  const { target, reason, candidates } = unresolved;
  if (reason === "no-tree") {
    return `The shared surface exposes no accessibility information, so nothing on it can be found by name. Say where "${target}" is out loud instead of drawing it.`;
  }
  const shown = candidates.slice(0, CANDIDATES_SHOWN).join(", ");
  // Counted off what the surface carried rather than off what arrived: the
  // host bounds the list before it crosses, so `candidates` is already the
  // short version of a page that had hundreds.
  const total = unresolved.candidateCount ?? candidates.length;
  const rest =
    total > CANDIDATES_SHOWN ? ` (and ${total - CANDIDATES_SHOWN} more)` : "";
  if (reason === "ambiguous") {
    return `More than one thing on the shared surface answers to "${target}": ${shown}${rest}. A name is matched whole, so there is no wording of "${target}" that picks one of them out. Point at a nearby control whose name is its own, or say where the thing is out loud.`;
  }
  return `Nothing on the shared surface is called "${target}". What is there: ${shown}${rest}. Point at one of those by name, or say where the thing is out loud. Do not fall back to guessing bounds for it: a ring drawn at a guess is worse than no ring, because it is followed.`;
};

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

/**
 * What a turn whose marks were overtaken is told.
 *
 * Not a failure to fix, which is why it says what is on the screen rather
 * than what to do: something else has since said what is pointed at, and the
 * screen is showing that. Pointing again here would take it back from
 * whatever asked last.
 */
const SUPERSEDED =
  "Another request changed what is pointed at while this one was resolving a name, so these marks were not drawn. The screen shows what that later request asked for.";

/** What the assistant is told for each way a set of marks can be refused. */
const REFUSALS: Record<CoachmarkRefusal, string> = {
  unshared: UNSHARED,
  "not-this-call": NOT_THIS_CALL,
  "stale-surface": STALE_SURFACE,
  superseded: SUPERSEDED,
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
 * its own, and the surface it would land on belongs to whichever call is
 * being shown the screen. See `showCompanionCoachmarks`, which answers with
 * the marks it placed, the refusal it made, or the name it could not resolve.
 *
 * Asynchronous because a mark that names a control is resolved against the
 * surface's accessibility tree, which is a round trip to the helper.
 */
export type CoachmarkPainter = (
  requests: readonly CoachmarkRequest[],
  conversationId?: string,
) => Promise<CoachmarkResult>;

const UNWIRED =
  "This client cannot draw on the screen: no coachmark painter is wired.";

/**
 * The one line the assistant reads, for each way a set of marks can end.
 *
 * A refusal and an unresolved name are both errors rather than results, and
 * deliberately so: each is a thing the assistant must act on, and an
 * assistant handed either as a result would go on to talk the user through a
 * ring that was never drawn.
 */
const answerFor = (
  result: CoachmarkResult,
): { executionResult: string } | { executionError: string } => {
  switch (result.kind) {
    case "placed":
      return { executionResult: PLACED(result) };
    case "refused":
      return { executionError: REFUSALS[result.refusal] };
    case "unresolved":
      return { executionError: UNRESOLVED(result.unresolved) };
  }
};

/**
 * The computer-use executor, with the pointing tool answered in this process.
 *
 * Delegation rather than a branch inside the shared executor: the shared one
 * is the transport to the native helper and is used by every desktop client,
 * and the frame it would be drawing on is this client's alone.
 */
class PointAtExecutor implements HostProxyExecutor {
  /**
   * Point-at requests still resolving a name.
   *
   * A name is looked up through the helper, so a request is out for as long
   * as that round trip takes and a cancel can arrive inside it. Held so a
   * cancel can tell one of those from a request that has already answered.
   */
  private readonly resolving = new Set<string>();

  /** Those of them a cancel has since named. */
  private readonly cancelled = new Set<string>();

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
        executionError: `Invalid marks: ${parsed.error.issues[0]?.message ?? "unreadable"}. Each mark either names what to point at, as {target, caption}, or gives {x, y, width, height} in fractions of the shared surface from 0 to 1.`,
      });
      return;
    }
    const paint = this.paint;
    if (!paint) {
      void poster.postCuResult({ requestId, executionError: UNWIRED });
      return;
    }
    const { marks } = parsed.data;
    // The conversation the daemon addressed this request to, which is what
    // lets the window layer tell the call's own turn from any other running
    // for the same user. Absent on a daemon too old to send it, which the
    // painter reads as a claim it cannot check.
    const conversationId = message.conversationId;
    const conversation =
      typeof conversationId === "string" ? conversationId : undefined;
    this.resolving.add(requestId);
    void paint(marks, conversation)
      .then((result) => {
        if (this.settle(requestId)) {
          return;
        }
        void poster.postCuResult({
          requestId,
          ...answerFor(result),
        });
      })
      .catch((err: unknown) => {
        // A painter that threw drew nothing, and the assistant has to hear
        // that rather than carry on describing a ring: it is not looking at
        // the screen it asked to draw on.
        log.warn("[host-cu-executor] point_at failed:", err);
        if (this.settle(requestId)) {
          return;
        }
        void poster.postCuResult({
          requestId,
          executionError:
            "The marks could not be drawn on the shared surface. Say where the thing is out loud instead.",
        });
      });
  }

  /**
   * Retire a request, and say whether a cancel reached it first.
   *
   * Both sets are emptied of it here, so a cancel that names a request no
   * longer out leaves nothing behind to accumulate.
   */
  private settle(requestId: string): boolean {
    this.resolving.delete(requestId);
    return this.cancelled.delete(requestId);
  }

  /**
   * Forwarded whatever the tool was, and recorded when it names a pointing
   * still out.
   *
   * A cancel names a request rather than a tool, so this cannot tell which
   * executor owns it and both are told. Resolving a name takes a round trip,
   * which is long enough for a cancel to land inside one, and the turn that
   * asked is gone by the time it answers, so no result is posted for it.
   *
   * What it drew is left alone. The screen belongs to whichever request
   * painted last, and a cancel answering after a later one has painted would
   * be taking down that request's marks rather than its own. Marks come down
   * on the next request, and when the share moves or ends.
   */
  handleCancel(message: HostProxySseMessage, poster: HostProxyPoster): void {
    const requestId = message.requestId as string | undefined;
    if (requestId !== undefined && this.resolving.has(requestId)) {
      this.cancelled.add(requestId);
    }
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
