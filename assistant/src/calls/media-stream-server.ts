/**
 * Media-stream call server: binds WebSocket lifecycle to call-session
 * lifecycle and wires STT session callbacks to controller entry points.
 *
 * Each active media-stream call has a single `MediaStreamCallSession`
 * instance that:
 *
 * 1. Owns a {@link MediaStreamSttSession} for ingesting raw audio and
 *    producing transcripts.
 * 2. Owns a {@link MediaStreamOutput} for sending synthesized audio
 *    and lifecycle signals back to Twilio.
 * 3. Creates and registers a {@link CallController} to process
 *    transcripts through the conversation pipeline.
 *
 * The server is registered on `/v1/calls/media-stream` and provides
 * full bidirectional call support: inbound audio is transcribed via
 * STT and outbound assistant speech is synthesized via TTS and
 * streamed as media frames back to Twilio.
 *
 * Lifecycle:
 * - WebSocket `open` -> extract callSessionId from upgrade params,
 *   create `MediaStreamCallSession`.
 * - Media stream `start` event -> capture streamSid/callSid, wire
 *   output adapter, run setup routing and hand the outcome to a
 *   `CallSetupFlow` (deny, verification, invite redemption, name
 *   capture / guardian wait, unverified caller, normal call). The
 *   controller is created only once the flow completes with a
 *   `proceed-*` result.
 * - Media stream `media` events -> forwarded to STT session for
 *   turn detection and transcription.
 * - STT `onTranscriptFinal` -> routed to the active setup flow's
 *   `pushTranscriptFinal()`, else the controller's
 *   `handleCallerUtterance()`.
 * - STT `onDtmf` -> routed to the active setup flow's
 *   `pushDtmfDigit()` for code-collection sub-flows.
 * - STT `onSpeechStart` -> barge-in: clears outbound audio queue
 *   and interrupts the in-flight LLM turn via the controller.
 * - Media stream `stop` event / WebSocket close -> finalize call.
 */

import type { ServerWebSocket } from "bun";

import { revokeScopedApprovalGrantsForContext } from "../approvals/scoped-approval-grants.js";
import {
  getGuardianDelivery,
  getGuardianDeliveryFresh,
  voiceGuardianDisplayName,
} from "../contacts/guardian-delivery-reader.js";
import { getAssistantName } from "../daemon/identity-helpers.js";
import { addMessage } from "../persistence/conversation-crud.js";
import { resolveGuardianName } from "../prompts/user-reference.js";
import { getLogger } from "../util/logger.js";
import { CallController } from "./call-controller.js";
import {
  formatDuration,
  postPointerMessageSafe,
} from "./call-pointer-messages.js";
import { CallSetupFlow, type CallSetupFlowDeps } from "./call-setup-flow.js";
import type { SetupFlowResult } from "./call-setup-flow-types.js";
import { speakSystemPrompt } from "./call-speech-output.js";
import {
  fireCallTranscriptNotifier,
  registerCallController,
  unregisterCallController,
} from "./call-state.js";
import { isTerminalState } from "./call-state-machine.js";
import {
  getCallSession,
  recordCallEvent,
  updateCallSession,
} from "./call-store.js";
import { getChannelAdmissionPolicy } from "./channel-admission-reader.js";
import { finalizeCall } from "./finalize-call.js";
import { getPhoneCallerVerdict } from "./inbound-trust-reader.js";
import { MediaStreamOutput } from "./media-stream-output.js";
import { parseMediaStreamFrame } from "./media-stream-parser.js";
import type { MediaStreamStartEvent } from "./media-stream-protocol.js";
import {
  MediaStreamSttSession,
  type MediaStreamSttSessionCallbacks,
  type MediaStreamSttSessionConfig,
} from "./media-stream-stt-session.js";
import { routeSetup } from "./call-setup-router.js";

const log = getLogger("media-stream-server");
const UUID_SHAPED_NAME =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Resolve the assistant's display name from identity configuration.
 * Returns the trimmed name, or null when unavailable or UUID-shaped.
 */
function resolveAssistantLabel(): string | null {
  try {
    const trimmed = getAssistantName()?.trim();
    if (!trimmed || UUID_SHAPED_NAME.test(trimmed)) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Active sessions registry (keyed by callSessionId)
// ---------------------------------------------------------------------------

/**
 * Active media-stream call sessions keyed by callSessionId.
 *
 * Exported for use in `call-domain.ts` (cancel call cleanup) and for
 * test assertions. Not intended for general consumption.
 */
export const activeMediaStreamSessions = new Map<
  string,
  MediaStreamCallSession
>();

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class MediaStreamCallSession {
  readonly callSessionId: string;
  private output: MediaStreamOutput;
  private sttSession: MediaStreamSttSession;
  private controller: CallController | null = null;
  /**
   * Active setup flow driving the pre-conversation phase (verification,
   * invite redemption, name capture, guardian wait, deny). Non-null from
   * setup routing until the flow completes; caller input routes into it
   * instead of the controller while set.
   */
  private setupFlow: CallSetupFlow | null = null;
  /** Guardian displayName primed from the gateway binding during setup. */
  private primedGuardianDisplayName: string | undefined;
  private streamSid: string | null = null;
  private callSid: string | null = null;
  private disposed = false;
  // True from the synchronous start of handleStart until setup routing
  // completes. Resolving the admission floor yields the event loop, so
  // transcripts/barge-in arriving in this window are ignored — a denied or
  // not-yet-authorized caller's speech is never persisted before the floor
  // and trust ACL are applied. The controller-existence checks below also
  // gate persistence, but this guard makes the intent explicit and covers
  // the brief async window before the controller is created.
  private setupRouting = false;
  // Resolves when the async setup routing kicked off by the `start` frame
  // settles. Exposed via whenSetupSettled() for deterministic test awaiting,
  // since handleStart now yields on the admission-policy read.
  private setupSettled: Promise<void> = Promise.resolve();

  // ── Operational diagnostics counters ──────────────────────────────
  /** Number of barge-in attempts that were accepted (assistant was speaking). */
  private bargeInAccepted = 0;
  /** Number of barge-in attempts that were ignored (assistant not speaking). */
  private bargeInIgnored = 0;
  /** Number of turn-start transitions detected by the STT session. */
  private turnStarts = 0;
  /** Number of transcript finals produced (non-empty). */
  private transcriptFinalsProduced = 0;

  constructor(
    ws: ServerWebSocket<unknown>,
    callSessionId: string,
    sttConfig?: MediaStreamSttSessionConfig,
  ) {
    this.callSessionId = callSessionId;

    // Create output adapter with a placeholder streamSid — it will be
    // set when the `start` event arrives.
    this.output = new MediaStreamOutput(ws, "");

    // Create STT session with callbacks wired to the controller.
    const callbacks: MediaStreamSttSessionCallbacks = {
      onSpeechStart: () => this.handleSpeechStart(),
      onTranscriptFinal: (text, durationMs) =>
        this.handleTranscriptFinal(text, durationMs),
      onDtmf: (digit) => this.handleDtmf(digit),
      onStop: () => this.handleStreamStop(),
      onError: (category, message) => this.handleSttError(category, message),
    };

    this.sttSession = new MediaStreamSttSession(sttConfig ?? {}, callbacks);

    log.info({ callSessionId }, "Media stream call session created");
  }

  /**
   * Get the output adapter (for test assertions).
   */
  getOutput(): MediaStreamOutput {
    return this.output;
  }

  /**
   * Get the controller (for test assertions).
   */
  getController(): CallController | null {
    return this.controller;
  }

  /**
   * Get the active setup flow (for test assertions).
   */
  getSetupFlow(): CallSetupFlow | null {
    return this.setupFlow;
  }

  /**
   * Resolves once the async setup routing started by the `start` frame has
   * settled. Test-only convenience — production code does not await this.
   */
  whenSetupSettled(): Promise<void> {
    return this.setupSettled;
  }

  /**
   * Feed a raw WebSocket message into the session.
   *
   * The message is parsed to intercept `start` events (for session
   * bootstrapping) before being forwarded to the STT session for
   * audio processing.
   */
  handleMessage(raw: string): void {
    if (this.disposed) return;

    // Intercept `start` to bootstrap the session before forwarding.
    const parseResult = parseMediaStreamFrame(raw);
    if (parseResult.ok && parseResult.event.event === "start") {
      // handleStart resolves the admission floor asynchronously; the
      // setupRouting guard set synchronously at its top ensures inbound
      // frames forwarded below are ignored until routing completes.
      this.setupSettled = this.handleStart(parseResult.event).catch((err) => {
        log.error(
          { err, callSessionId: this.callSessionId },
          "Media-stream setup routing failed",
        );
        this.setupRouting = false;
      });
    }

    // Always forward to the STT session (it handles all event types).
    this.sttSession.handleMessage(raw);
  }

  /**
   * Handle WebSocket close. Finalizes the call session if not already
   * in a terminal state.
   */
  handleTransportClosed(code?: number, reason?: string): void {
    if (this.disposed) return;

    // Tear down an in-flight setup flow first: clears its timers and emits
    // the guardian-wait callback handoff when the caller opted in.
    const setupFlow = this.setupFlow;
    this.setupFlow = null;
    setupFlow?.dispose("transport_closed");

    const session = getCallSession(this.callSessionId);
    if (!session) return;
    if (isTerminalState(session.status)) {
      // A hangup during a flow-terminal goodbye: dispose above swallowed the
      // flow's pending complete(), so finalize + revoke grants here. Normal
      // completion nulls setupFlow and hasFinalized() covers flow-side
      // finalization, keeping this exactly-once.
      if (setupFlow && !setupFlow.hasFinalized()) {
        this.runFinalizationAndGrantCleanup(session);
      }
      return;
    }

    const isNormalClose = code === 1000;
    const terminationReason = isNormalClose ? "normal_stop" : "premature_abort";
    log.info(
      {
        callSessionId: this.callSessionId,
        terminationReason,
        closeCode: code,
        closeReason: reason,
        turnStarts: this.turnStarts,
        transcriptFinalsProduced: this.transcriptFinalsProduced,
        bargeInAccepted: this.bargeInAccepted,
        bargeInIgnored: this.bargeInIgnored,
      },
      "Media stream transport closed — session diagnostics",
    );
    if (isNormalClose) {
      updateCallSession(this.callSessionId, {
        status: "completed",
        endedAt: Date.now(),
      });
      recordCallEvent(this.callSessionId, "call_ended", {
        reason: reason || "media_stream_closed",
        closeCode: code,
      });

      if (session.initiatedFromConversationId) {
        const durationMs = session.startedAt
          ? Date.now() - session.startedAt
          : 0;
        postPointerMessageSafe(
          session.initiatedFromConversationId,
          "completed",
          session.toNumber,
          {
            duration: durationMs > 0 ? formatDuration(durationMs) : undefined,
          },
        );
      }
    } else {
      const detail =
        reason ||
        (code ? `media_stream_closed_${code}` : "media_stream_closed_abnormal");
      updateCallSession(this.callSessionId, {
        status: "failed",
        endedAt: Date.now(),
        lastError: `Media stream WebSocket closed unexpectedly: ${detail}`,
      });
      recordCallEvent(this.callSessionId, "call_failed", {
        reason: detail,
        closeCode: code,
      });

      if (session.initiatedFromConversationId) {
        postPointerMessageSafe(
          session.initiatedFromConversationId,
          "failed",
          session.toNumber,
          { reason: detail },
        );
      }
    }

    this.revokeScopedGrants(session.conversationId);

    // A setup flow that reached a flow-terminal path already ran
    // finalizeCall — keep finalization exactly-once.
    if (!setupFlow?.hasFinalized()) {
      finalizeCall(this.callSessionId, session.conversationId);
    }
  }

  /**
   * Dispose of the session, cleaning up all resources.
   */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.sttSession.dispose();

    this.setupFlow?.dispose("teardown");
    this.setupFlow = null;

    if (this.controller) {
      this.controller.destroy();
      unregisterCallController(this.callSessionId);
      this.controller = null;
    }

    this.output.markClosed();

    log.info(
      {
        callSessionId: this.callSessionId,
        turnStarts: this.turnStarts,
        transcriptFinalsProduced: this.transcriptFinalsProduced,
        bargeInAccepted: this.bargeInAccepted,
        bargeInIgnored: this.bargeInIgnored,
      },
      "Media stream call session destroyed",
    );
  }

  // ── Internal: media-stream event handlers ─────────────────────────

  private async handleStart(event: MediaStreamStartEvent): Promise<void> {
    // Enter the setup-pending window synchronously, before any await. The
    // admission-policy read below yields the event loop, so frames forwarded
    // to the STT session can produce transcripts/barge-in before routing
    // completes — those are dropped while setupRouting is true.
    this.setupRouting = true;
    this.streamSid = event.streamSid;
    this.callSid = event.start.callSid;

    // Update the output adapter with the real streamSid.
    this.output.setStreamSid(event.streamSid);

    // Update the call session with the provider call SID.
    const session = getCallSession(this.callSessionId);
    if (session) {
      const updates: Parameters<typeof updateCallSession>[1] = {
        providerCallSid: event.start.callSid,
      };
      if (
        !isTerminalState(session.status) &&
        session.status !== "in_progress" &&
        session.status !== "waiting_on_user"
      ) {
        updates.status = "in_progress";
        if (!session.startedAt) updates.startedAt = Date.now();
      }
      updateCallSession(this.callSessionId, updates);
    }

    recordCallEvent(this.callSessionId, "call_connected", {
      callSid: event.start.callSid,
      streamSid: event.streamSid,
      encoding: event.start.mediaFormat.encoding,
      sampleRate: event.start.mediaFormat.sampleRate,
      transport: "media-stream",
    });

    // ── Setup-policy routing ────────────────────────────────────────
    // Run routeSetup() to enforce ACL/deny/escalate, verification, and
    // invite flows. The resulting outcome is handed to a CallSetupFlow,
    // which drives every interactive sub-flow (DTMF/spoken code entry,
    // invite redemption, name capture, guardian wait) over this
    // transport.
    const from = session?.fromNumber ?? "";
    const to = session?.toNumber ?? "";

    // Resolve the phone channel's inbound admission floor so the trust floor
    // (e.g. guardian_only) is enforced on this transport too — not just the
    // gateway webhook's no_one kill switch. The reader fails open to `null`
    // by contract, so a transport hiccup admits the caller.
    //
    // Concurrently, prime the guardian displayName used by setup-flow copy
    // and warm the phone-channel guardian-delivery cache for routeSetup's
    // SYNC resolveActorTrust fallback (gateway-side binding writes don't
    // invalidate the daemon cache, so read fresh). All three are independent
    // IPC reads on different cache keys.
    const [admissionPolicy] = await Promise.all([
      getChannelAdmissionPolicy("phone"),
      this.primeGuardianDisplayName(),
      getGuardianDeliveryFresh({ channelTypes: ["phone"] }),
    ]);

    // The admission-policy read above yields the event loop; if Twilio closed
    // the WebSocket meanwhile, the close handler will have called destroy().
    // Abort setup so we don't create a controller or speak on a disposed
    // session.
    if (this.abortIfDisposed("admission read")) {
      return;
    }

    // Verdict-first caller trust so this transport enforces the gateway
    // ACL. routeSetup uses it when present and not resolutionFailed, else
    // falls back to local resolution. The reader returns null on failure,
    // keeping the local path on a gateway blip.
    const isInbound = session?.initiatedFromConversationId == null;
    const otherPartyNumber = isInbound ? from : to;
    const verdict = await getPhoneCallerVerdict(otherPartyNumber);

    // The verdict read above yields the event loop; abort if the session was
    // disposed meanwhile, matching the admission-read guard above.
    if (this.abortIfDisposed("verdict read")) {
      return;
    }

    const { outcome, resolved } = await routeSetup({
      callSessionId: this.callSessionId,
      session: session ?? null,
      from,
      to,
      customParameters: event.start.customParameters,
      admissionPolicy,
      verdict,
    });

    // routeSetup can yield the event loop (gateway voice-invite read); abort
    // if the session was disposed meanwhile, matching the guards above.
    if (this.abortIfDisposed("setup routing")) {
      return;
    }

    log.info(
      {
        callSessionId: this.callSessionId,
        streamSid: this.streamSid,
        callSid: this.callSid,
        setupAction: outcome.action,
      },
      "Media stream session started",
    );

    const flow = new CallSetupFlow(
      this.callSessionId,
      this.output,
      this.buildSetupFlowDeps(session),
    );
    this.setupFlow = flow;
    // Routing/ACL cleared — the flow owns the setup phase from here, so
    // transcripts and DTMF route into it until it completes.
    this.setupRouting = false;
    await flow.start(outcome, resolved);
  }

  // ── Setup flow wiring ─────────────────────────────────────────────

  /**
   * Abort a pending setup when the session was disposed across an await
   * in {@link handleStart}: logs the stage and clears the setup-routing
   * input gate. Returns true when setup must abort.
   */
  private abortIfDisposed(stage: string): boolean {
    if (!this.disposed) {
      return false;
    }
    log.info(
      { callSessionId: this.callSessionId, stage },
      "Media-stream session disposed during setup — aborting",
    );
    this.setupRouting = false;
    return true;
  }

  /**
   * Real side-effect surface for the {@link CallSetupFlow}. Pure-logic
   * deps (code validation, invite redemption, guardian notification,
   * trust re-resolution, guardian wait construction) use the flow's
   * real-implementation defaults.
   */
  private buildSetupFlowDeps(
    session: ReturnType<typeof getCallSession>,
  ): CallSetupFlowDeps {
    return {
      speakSystemPrompt: (text) => speakSystemPrompt(this.output, text),
      updateCallSession,
      recordCallEvent,
      onComplete: (result) => this.handleSetupFlowResult(result, session),
      getCallSession,
      // Flow-terminal paths set a terminal session status, so the
      // transport-close handler skips its cleanup — revoke scoped grants
      // here alongside finalization.
      finalizeCall: (callSessionId, conversationId) => {
        this.revokeScopedGrants(conversationId);
        finalizeCall(callSessionId, conversationId);
      },
      addMessage,
      postPointerMessage: postPointerMessageSafe,
      fireCallTranscriptNotifier,
      resolveGuardianLabel: () =>
        resolveGuardianName(this.primedGuardianDisplayName),
      resolveAssistantLabel,
    };
  }

  /**
   * Continue the call once the setup flow reaches a terminal result:
   * create + register the call controller and fire the matching opener
   * for `proceed-*` variants, or complete finalization for `ended`
   * (the flow already spoke its terminal copy, set terminal status,
   * and scheduled its own delayed `endSession`).
   */
  private handleSetupFlowResult(
    result: SetupFlowResult,
    session: ReturnType<typeof getCallSession>,
  ): void {
    const flow = this.setupFlow;
    this.setupFlow = null;

    if (result.kind === "ended") {
      // handleTransportClosed will see the terminal status and exit early
      // when the WebSocket closes, so run cleanup inline — unless a
      // flow-terminal path already finalized (grants revoked there too).
      if (!flow?.hasFinalized()) {
        this.runFinalizationAndGrantCleanup(session);
      }
      return;
    }

    const controller = new CallController(
      this.callSessionId,
      this.output,
      session?.task ?? null,
      {
        assistantId: result.assistantId,
        trustContext: result.trustContext,
      },
    );
    this.controller = controller;
    registerCallController(this.callSessionId, controller);

    const opener =
      result.kind === "proceed-post-verification-greeting"
        ? controller.startPostVerificationGreeting()
        : result.kind === "proceed-handoff-spoken"
          ? Promise.resolve(controller.markNextCallerTurnAsOpeningAck())
          : controller.startInitialGreeting();

    const deferredTranscripts = result.deferredTranscripts ?? [];
    void opener
      .then(async () => {
        // Replay transcripts buffered during mid-setup trust re-resolution,
        // in order, so the caller's first utterance runs under the upgraded
        // trust context.
        for (const text of deferredTranscripts) {
          await controller.handleCallerUtterance(text);
        }
      })
      .catch((err) => {
        log.error(
          { err, callSessionId: this.callSessionId },
          "Failed to start call flow after setup completion",
        );
      });
  }

  /**
   * Prime the guardian displayName from the gateway binding so the
   * synchronous setup-flow label path can read it without an IPC
   * round-trip.
   */
  private async primeGuardianDisplayName(): Promise<void> {
    const list = await getGuardianDelivery();
    this.primedGuardianDisplayName = voiceGuardianDisplayName(list);
  }

  // ── Finalization helpers for early-teardown paths ─────────────────

  /**
   * Revoke any scoped approval grants bound to this call session.
   * Revoke by both callSessionId and conversationId because the
   * guardian-approval-interception minting path sets callSessionId: null
   * but always sets conversationId.
   */
  private revokeScopedGrants(conversationId: string | undefined): void {
    try {
      revokeScopedApprovalGrantsForContext({
        callSessionId: this.callSessionId,
      });
      if (conversationId) {
        revokeScopedApprovalGrantsForContext({ conversationId });
      }
    } catch (err) {
      log.warn(
        { err, callSessionId: this.callSessionId },
        "Failed to revoke scoped grants for media-stream session",
      );
    }
  }

  /**
   * Run scoped-grant revocation and call finalization inline. Used for
   * setup-terminal paths which set terminal status before `endSession()`.
   * When the WebSocket subsequently closes, {@link handleTransportClosed}
   * sees the terminal status and exits early — so cleanup must happen
   * here to avoid leaking grants and skipping `finalizeCall()`
   * side-effects.
   */
  private runFinalizationAndGrantCleanup(
    session: ReturnType<typeof getCallSession>,
  ): void {
    this.revokeScopedGrants(session?.conversationId);
    if (session?.conversationId) {
      finalizeCall(this.callSessionId, session.conversationId);
    }
  }

  // ── STT callbacks ─────────────────────────────────────────────────

  private handleSpeechStart(): void {
    this.turnStarts++;

    // Barge-in: clear queued outbound audio and abort the in-flight LLM
    // turn only when the assistant is actively speaking. Uses the gated
    // handleBargeIn path so initial inbound audio frames do not cancel a
    // still-starting initial turn.
    //
    // clearAudio runs via the onAccepted hook so it only fires when the
    // barge-in passes the speaking gate — an ignored barge-in (controller
    // idle/processing) must not flush queued/in-flight TTS such as a
    // buffered greeting. The hook runs before handleInterrupt so the
    // end-of-turn mark it enqueues survives the queue flush.
    if (this.output && this.controller) {
      const output = this.output;
      const accepted = this.controller.handleBargeIn(() =>
        output.clearAudio(),
      );
      if (accepted) {
        this.bargeInAccepted++;
        log.info(
          { callSessionId: this.callSessionId },
          "Media-stream barge-in accepted — cleared outbound audio",
        );
      } else {
        // No turn to abort, but a completed turn's tail can still be
        // playing from Twilio's buffer — flush only that buffer so the
        // caller isn't talked over. Queued speech that hasn't reached
        // Twilio yet (greeting, handoff prompt) is preserved.
        output.clearBufferedAudio();
        this.bargeInIgnored++;
        log.debug(
          { callSessionId: this.callSessionId },
          "Media-stream barge-in ignored — assistant not speaking",
        );
      }
    }
  }

  private handleTranscriptFinal(text: string, _durationMs: number): void {
    if (!text.trim()) return;

    // Drop transcripts arriving while setup routing is still pending so a
    // not-yet-authorized / floor-denied caller's speech is never persisted
    // before the admission floor and trust ACL are applied.
    if (this.setupRouting) {
      log.debug(
        { callSessionId: this.callSessionId },
        "Transcript received during setup routing — dropping",
      );
      return;
    }

    this.transcriptFinalsProduced++;

    // While a setup flow is active it owns caller speech (name capture,
    // spoken code entry, guardian-wait utterances). Fire the transcript
    // notifier for UI subscribers, then route into the flow.
    if (this.setupFlow) {
      const setupSession = getCallSession(this.callSessionId);
      if (setupSession) {
        fireCallTranscriptNotifier(
          setupSession.conversationId,
          this.callSessionId,
          "caller",
          text,
        );
      }
      this.setupFlow.pushTranscriptFinal(text);
      return;
    }

    if (!this.controller) {
      log.warn(
        { callSessionId: this.callSessionId },
        "Transcript received but no controller — dropping",
      );
      return;
    }

    const session = getCallSession(this.callSessionId);
    if (session) {
      fireCallTranscriptNotifier(
        session.conversationId,
        this.callSessionId,
        "caller",
        text,
      );
    }

    recordCallEvent(this.callSessionId, "caller_spoke", {
      transcript: text,
      transport: "media-stream",
    });

    // Route to the controller for conversation-backed response.
    this.controller.handleCallerUtterance(text).catch((err) => {
      log.error(
        { err, callSessionId: this.callSessionId },
        "Controller failed to handle caller utterance",
      );
    });
  }

  private handleDtmf(digit: string): void {
    // Drop DTMF arriving while setup routing is still pending so a
    // not-yet-authorized / floor-denied caller's digit is never persisted
    // before the admission floor and trust ACL are applied.
    if (this.setupRouting) {
      log.debug(
        { callSessionId: this.callSessionId, digit },
        "DTMF received during setup routing — dropping",
      );
      return;
    }

    log.info(
      { callSessionId: this.callSessionId, digit },
      "DTMF digit received on media-stream",
    );
    recordCallEvent(this.callSessionId, "caller_spoke", {
      dtmfDigit: digit,
      transport: "media-stream",
    });

    // While a setup flow is active, digits feed its code-collection
    // sub-flows (the flow itself records no per-digit events).
    this.setupFlow?.pushDtmfDigit(digit);
  }

  private handleStreamStop(): void {
    log.info(
      { callSessionId: this.callSessionId },
      "Media stream stop event received",
    );
    // The WebSocket close handler will finalize the call session.
  }

  private handleSttError(category: string, message: string): void {
    log.error(
      { callSessionId: this.callSessionId, category, message },
      "STT error on media-stream session",
    );
    recordCallEvent(this.callSessionId, "call_failed", {
      reason: `STT error: ${category} — ${message}`,
      transport: "media-stream",
    });
  }
}
