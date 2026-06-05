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
 *   output adapter, create controller.
 * - Media stream `media` events -> forwarded to STT session for
 *   turn detection and transcription.
 * - STT `onTranscriptFinal` -> routed to controller's
 *   `handleCallerUtterance()`.
 * - STT `onSpeechStart` -> barge-in: clears outbound audio queue
 *   and interrupts the in-flight LLM turn via the controller.
 * - Media stream `stop` event / WebSocket close -> finalize call.
 */

import type { ServerWebSocket } from "bun";

import {
  findGuardianForChannel,
  listGuardianChannels,
} from "../contacts/contact-store.js";
import { getAssistantName } from "../daemon/identity-helpers.js";
import { addMessage } from "../memory/conversation-crud.js";
import { revokeScopedApprovalGrantsForContext } from "../memory/scoped-approval-grants.js";
import { resolveGuardianName } from "../prompts/user-reference.js";
import { notifyGuardianOfAccessRequest } from "../runtime/access-request-helper.js";
import { resolveActorTrust } from "../runtime/actor-trust-resolver.js";
import { getLogger } from "../util/logger.js";
import { CallController } from "./call-controller.js";
import { addPointerMessage, formatDuration } from "./call-pointer-messages.js";
import {
  CallSetupFlow,
  type CallSetupFlowDeps,
  type SetupFlowSession,
} from "./call-setup-flow.js";
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
import { finalizeCall } from "./finalize-call.js";
import { MediaStreamOutput } from "./media-stream-output.js";
import { parseMediaStreamFrame } from "./media-stream-parser.js";
import type { MediaStreamStartEvent } from "./media-stream-protocol.js";
import {
  MediaStreamSttSession,
  type MediaStreamSttSessionCallbacks,
  type MediaStreamSttSessionConfig,
} from "./media-stream-stt-session.js";
import { routeSetup } from "./relay-setup-router.js";
import {
  describeCredentialGaps,
  resolveTelephonyCredentialReadiness,
} from "./telephony-credential-preflight.js";
import type { CallEventType } from "./types.js";

const UUID_SHAPED_NAME =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const log = getLogger("media-stream-server");

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
   * Active interactive setup flow (verification / invite / name-capture /
   * unverified / deny). Non-null while the deterministic pre-conversation
   * phase is collecting input; cleared once `onComplete` fires. While active,
   * caller input (DTMF + finalized transcripts) is routed into the flow rather
   * than the controller.
   */
  private setupFlow: CallSetupFlow | null = null;
  private streamSid: string | null = null;
  private callSid: string | null = null;
  private disposed = false;

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
      this.handleStart(parseResult.event);
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

    // Dispose any in-flight setup flow first so the GuardianWaitController
    // emits the opted-in callback handoff (mirroring relay-server's
    // `handleTransportClosed`, which fires the callback handoff before cleanup)
    // and clears its timers before the session is finalized.
    if (this.setupFlow) {
      this.setupFlow.dispose();
      this.setupFlow = null;
    }

    const session = getCallSession(this.callSessionId);
    if (!session) return;
    if (isTerminalState(session.status)) return;

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
        addPointerMessage(
          session.initiatedFromConversationId,
          "completed",
          session.toNumber,
          {
            duration: durationMs > 0 ? formatDuration(durationMs) : undefined,
          },
        ).catch((err) => {
          log.warn(
            { conversationId: session.initiatedFromConversationId, err },
            "Skipping pointer write — origin conversation may no longer exist",
          );
        });
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
        addPointerMessage(
          session.initiatedFromConversationId,
          "failed",
          session.toNumber,
          { reason: detail },
        ).catch((err) => {
          log.warn(
            { conversationId: session.initiatedFromConversationId, err },
            "Skipping pointer write — origin conversation may no longer exist",
          );
        });
      }
    }

    // Revoke any scoped approval grants bound to this call session.
    // Revoke by both callSessionId and conversationId because the
    // guardian-approval-interception minting path sets callSessionId: null
    // but always sets conversationId.
    try {
      revokeScopedApprovalGrantsForContext({
        callSessionId: this.callSessionId,
      });
      revokeScopedApprovalGrantsForContext({
        conversationId: session.conversationId,
      });
    } catch (err) {
      log.warn(
        { err, callSessionId: this.callSessionId },
        "Failed to revoke scoped grants on media-stream transport close",
      );
    }

    finalizeCall(this.callSessionId, session.conversationId);
  }

  /**
   * Dispose of the session, cleaning up all resources.
   */
  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.sttSession.dispose();

    // Dispose any in-flight setup flow so the GuardianWaitController's timers
    // are cleared and (if the caller had opted into a callback while still
    // waiting) the transport-closed callback handoff fires.
    if (this.setupFlow) {
      this.setupFlow.dispose();
      this.setupFlow = null;
    }

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

  private handleStart(event: MediaStreamStartEvent): void {
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
    // Run the same routeSetup() that the ConversationRelay path uses to
    // enforce ACL/deny/escalate, verification, invite, and name-capture flows.
    // Every outcome is driven by a CallSetupFlow over the media-stream output
    // transport, achieving parity with the ConversationRelay setup path. The
    // flow speaks prompts, collects DTMF/speech, runs guardian waits, and
    // reports back (via onComplete) which greeting/handoff continuation to
    // perform.
    const from = session?.fromNumber ?? "";
    const to = session?.toNumber ?? "";

    const { outcome, resolved } = routeSetup({
      callSessionId: this.callSessionId,
      session: session ?? null,
      from,
      to,
      customParameters: event.start.customParameters,
    });

    log.info(
      {
        callSessionId: this.callSessionId,
        streamSid: this.streamSid,
        callSid: this.callSid,
        setupAction: outcome.action,
      },
      "Media stream session started",
    );

    const setupFlow = new CallSetupFlow(
      this.callSessionId,
      this.output,
      this.buildSetupFlowDeps(),
    );
    this.setupFlow = setupFlow;

    // Drive the routed outcome. `onComplete` (wired in buildSetupFlowDeps)
    // creates the controller / fires the matching opener / tears down. The
    // returned promise rejects only on an off-contract action; surface it.
    setupFlow.start(outcome, resolved).catch((err) => {
      log.error(
        { err, callSessionId: this.callSessionId, action: outcome.action },
        "Media-stream setup flow failed",
      );
      // Fail closed: mark the session failed, finalize, and end the call so a
      // setup-flow error never leaves the caller connected-and-silent.
      const current = getCallSession(this.callSessionId);
      if (current && !isTerminalState(current.status)) {
        updateCallSession(this.callSessionId, {
          status: "failed",
          endedAt: Date.now(),
          lastError: `Media-stream setup flow error: ${String(err)}`,
        });
      }
      this.runFinalizationAndGrantCleanup(getCallSession(this.callSessionId));
      this.output.endSession("Media-stream setup flow error");
    });
  }

  /**
   * Assemble the {@link CallSetupFlowDeps} backed by the real implementations
   * the ConversationRelay path uses, so media-stream setup achieves parity with
   * the CR relay flow (copy/label/persona, access-request creation + guardian
   * notification, post-verification trust recompute, pointer/notifier writes,
   * exactly-once finalization, guardian-wait controller construction).
   *
   * `onComplete` is the bridge from the deterministic setup phase to the
   * conversation phase: it creates and registers the {@link CallController}
   * (with the result's recomputed trust context) and fires the matching opener,
   * or tears the session down for the terminal `ended` outcome.
   */
  private buildSetupFlowDeps(): CallSetupFlowDeps {
    return {
      // The transport handed to the flow is always this session's
      // MediaStreamOutput, which satisfies CallTransport; speak through it.
      speakSystemPrompt: (_transport, text) =>
        speakSystemPrompt(this.output, text),
      recordCallEvent: (callSessionId, eventType, payload) =>
        recordCallEvent(callSessionId, eventType as CallEventType, payload),
      onComplete: (result) => this.handleSetupComplete(result),
      getSession: () =>
        this.toSetupFlowSession(getCallSession(this.callSessionId)),
      postCalleeVerificationCode: (conversationId, toNumber, code) =>
        this.postCalleeVerificationCode(conversationId, toNumber, code),
      addPointerMessage: (conversationId, event, phoneNumber, extra) =>
        addPointerMessage(conversationId, event, phoneNumber, extra),
      fireTranscript: (conversationId, callSessionId, speaker, text) =>
        fireCallTranscriptNotifier(
          conversationId,
          callSessionId,
          speaker,
          text,
        ),
      resolveActorTrust: (input) => resolveActorTrust(input),
      resolveGuardianLabel: () => this.resolveGuardianLabel(),
      resolveAssistantLabel: () => this.resolveAssistantLabel(),
      // Only the copy that DIFFERS from CallSetupFlow's built-in defaults is
      // overridden here, to port relay-server's exact wording. The
      // name-capture / unverified / access-approved / access-denied /
      // access-timeout copy is byte-identical to the flow defaults, so those
      // deps are intentionally left unset.
      //
      // - invite redemption / handoff add the relay outbound + assistant-name
      //   variants the defaults lack.
      // - trusted-contact handoff uses relay's "guardian said I can speak with
      //   you" copy rather than the flow's terser "You're verified" default.
      composeInviteRedemptionPrompt: ({
        isOutbound,
        friendName,
        guardianName,
      }) => {
        const displayFriend = friendName ?? "there";
        const displayGuardian = guardianName ?? "your contact";
        if (isOutbound) {
          const assistantName = this.resolveAssistantLabel();
          return assistantName
            ? `Hi ${displayFriend}, this is ${assistantName}, ${displayGuardian}'s assistant. To get started, please enter the 6-digit code that ${displayGuardian} shared with you.`
            : `Hi ${displayFriend}, this is ${displayGuardian}'s assistant. To get started, please enter the 6-digit code that ${displayGuardian} shared with you.`;
        }
        return `Welcome ${displayFriend}. Please enter the 6-digit code that ${displayGuardian} provided you to verify your identity.`;
      },
      composeInviteHandoffText: ({ friendName, guardianName }) => {
        const assistantName = this.resolveAssistantLabel();
        const gLabel = guardianName || this.resolveGuardianLabel();
        if (friendName) {
          return assistantName
            ? `Great, I've verified that you are ${friendName}. It's nice to meet you! I'm ${assistantName}, ${gLabel}'s assistant. How can I help?`
            : `Great, I've verified that you are ${friendName}. It's nice to meet you! How can I help?`;
        }
        return assistantName
          ? `Great, I've verified your identity. It's nice to meet you! I'm ${assistantName}, ${gLabel}'s assistant. How can I help?`
          : `Great, I've verified your identity. It's nice to meet you! How can I help?`;
      },
      composeTrustedContactHandoffText: () =>
        `Great! ${this.resolveGuardianLabel()} said I can speak with you. How can I help?`,
      createAccessRequest: ({ assistantId, fromNumber, callerName }) => {
        const result = notifyGuardianOfAccessRequest({
          canonicalAssistantId: assistantId,
          sourceChannel: "phone",
          conversationExternalId: fromNumber,
          actorExternalId: fromNumber,
          actorDisplayName: callerName,
        });
        return result.notified ? result.requestId : null;
      },
      markWaitingOnUser: () =>
        updateCallSession(this.callSessionId, { status: "waiting_on_user" }),
      finalizeFailedCall: (reason) => this.finalizeFailedSetup(reason),
    };
  }

  /**
   * Bridge a resolved setup flow to the conversation phase. For the three
   * "proceed" continuations, create + register the controller with the
   * result's recomputed trust context and fire the matching opener; for
   * `ended`, run finalization and tear the session down.
   */
  private handleSetupComplete(result: SetupFlowResult): void {
    // The setup phase is over — stop routing caller input into the flow.
    this.setupFlow = null;

    // Guard against a completion that resolves AFTER the transport already
    // closed. An interactive flow can still be awaiting async work (e.g.
    // outbound verification awaiting postPointer) when the caller hangs up;
    // handleTransportClosed() disposes the flow and finalizes the session, but
    // CallSetupFlow.dispose() can't cancel an already-scheduled completion.
    // Without this guard a late completion would create/register a new
    // CallController and start a greeting on an already-closed/terminal call.
    if (this.disposed) return;
    const currentSession = getCallSession(this.callSessionId);
    if (currentSession && isTerminalState(currentSession.status)) return;

    if (result.kind === "ended") {
      // Terminal setup outcome (deny / unverified / verification failure /
      // guardian denial or timeout). The flow has already spoken the copy and
      // scheduled the transport teardown.
      //
      // Some terminal outcomes (unverified_caller, invite-code failure,
      // guardian denial / timeout, name-capture timeout) finalize THEMSELVES
      // from inside `CallSetupFlow` via the injected `finalizeFailedCall` dep
      // (→ `finalizeFailedSetup` → `runFinalizationAndGrantCleanup` →
      // `finalizeCall`). Those drive the session to a terminal status before
      // the flow resolves `ended`. If we unconditionally finalized again here
      // we'd persist a second completion message and fire a second completion
      // notifier (duplicate side effects).
      //
      // So make finalization exactly-once: only the outcomes that have NOT
      // already finalized (currently just the `deny` path, which resolves
      // `ended` without calling `finalizeFailedCall`) fall through to the
      // inline finalize. A session that is already terminal here has already
      // been finalized by the flow, so we skip — preserving a single
      // completion message + single notifier for every terminal path.
      const session = getCallSession(this.callSessionId);
      if (session && isTerminalState(session.status)) {
        // Already finalized by the flow's `finalizeFailedCall` — nothing to do.
        return;
      }
      if (session) {
        updateCallSession(this.callSessionId, {
          status: "failed",
          endedAt: Date.now(),
          lastError: result.reason,
        });
      }
      this.runFinalizationAndGrantCleanup(getCallSession(this.callSessionId));
      return;
    }

    const sessionRow = getCallSession(this.callSessionId);
    this.controller = new CallController(
      this.callSessionId,
      this.output,
      sessionRow?.task ?? null,
      {
        assistantId: result.assistantId,
        trustContext: result.trustContext,
      },
    );
    registerCallController(this.callSessionId, this.controller);

    switch (result.kind) {
      case "proceed-initial-greeting":
        // Credential-compatibility preflight before the first greeting; when
        // not ready, tear down, speak a setup-required message, and end the
        // call instead of connect-and-sit-silent.
        void this.preflightCredentialsThenGreet(sessionRow);
        return;
      case "proceed-post-verification-greeting":
        this.controller.startPostVerificationGreeting().catch((err) => {
          log.error(
            { err, callSessionId: this.callSessionId },
            "Failed to start post-verification greeting on media-stream session",
          );
        });
        return;
      case "proceed-handoff-spoken":
        // A handoff/greeting was already spoken by the flow; the next caller
        // turn should be treated as an opening acknowledgment rather than
        // re-greeting.
        //
        // Restore `in_progress` when the session is parked in
        // `waiting_on_user`. Name-capture enters the guardian wait via
        // `markWaitingOnUser` (session → `waiting_on_user`); on approval the
        // flow resolves `proceed-handoff-spoken` and we create the live
        // controller above, but without this the session would stay
        // `waiting_on_user` for the rest of an actively-connected call until
        // hangup. Relay-server restores `in_progress` in
        // `continueCallAfterTrustedContactActivation`; this matches that
        // behavior. Guard on `waiting_on_user` so we never clobber a terminal
        // status (validateTransition would reject it anyway) and only act when
        // a wait actually happened.
        if (sessionRow?.status === "waiting_on_user") {
          updateCallSession(this.callSessionId, { status: "in_progress" });
        }
        this.controller.markNextCallerTurnAsOpeningAck();
        return;
    }
  }

  // ── Setup-flow dep implementations ───────────────────────────────

  /** Project a call-session row onto the narrow shape the setup flow reads. */
  private toSetupFlowSession(
    session: ReturnType<typeof getCallSession>,
  ): SetupFlowSession | null {
    if (!session) return null;
    return {
      conversationId: session.conversationId,
      toNumber: session.toNumber,
      initiatedFromConversationId: session.initiatedFromConversationId ?? null,
    };
  }

  /**
   * Post the generated callee-verification code into the originating
   * conversation so the user can relay it. Mirrors the `addMessage(...)` write
   * in `relay-server.startVerification`.
   */
  private async postCalleeVerificationCode(
    conversationId: string,
    toNumber: string,
    code: string,
  ): Promise<void> {
    const codeMsg = `\u{1F510} Verification code for call to ${toNumber}: ${code}`;
    await addMessage(
      conversationId,
      "assistant",
      JSON.stringify([{ type: "text", text: codeMsg }]),
      {
        metadata: {
          userMessageChannel: "phone",
          assistantMessageChannel: "phone",
          userMessageInterface: "phone",
          assistantMessageInterface: "phone",
        },
      },
    );
  }

  /**
   * Mark the session failed and run finalization for a terminal setup failure
   * (denial / timeout / unverified / invite failure). Mirrors relay-server's
   * `updateCallSession({ status: "failed" })` + `finalizeCall(...)`.
   */
  private finalizeFailedSetup(reason: string): void {
    const session = getCallSession(this.callSessionId);
    if (session && !isTerminalState(session.status)) {
      updateCallSession(this.callSessionId, {
        status: "failed",
        endedAt: Date.now(),
        lastError: reason,
      });
    }
    this.runFinalizationAndGrantCleanup(session);
  }

  /**
   * Resolve a human-readable guardian label for voice setup copy. Mirrors
   * `relay-server.resolveGuardianLabel`: prefer the per-channel guardian's
   * displayName, fall back to any guardian channel, then to the shared
   * `resolveGuardianName` default.
   */
  private resolveGuardianLabel(): string {
    const voiceGuardian = findGuardianForChannel("phone");
    const guardianChannels = voiceGuardian ? null : listGuardianChannels();
    const guardianContact = voiceGuardian?.contact ?? guardianChannels?.contact;
    return resolveGuardianName(guardianContact?.displayName);
  }

  /**
   * Resolve the assistant's display name for setup greetings, or null when it
   * is unavailable / UUID-shaped. Mirrors `relay-server.resolveAssistantLabel`.
   */
  private resolveAssistantLabel(): string | null {
    try {
      const name = getAssistantName();
      const trimmedName = name?.trim();
      if (!trimmedName || UUID_SHAPED_NAME.test(trimmedName)) {
        return null;
      }
      return trimmedName;
    } catch {
      return null;
    }
  }

  /**
   * Run the media-stream credential preflight for a normal call. When ready,
   * fire the initial greeting through the already-created controller. When NOT
   * ready, tear the just-bootstrapped controller down, record the failure
   * event, speak a short setup-required message over the normal media-stream
   * TTS path, and end the call — never connect-and-sit-silent.
   *
   * The not-ready teardown mirrors the deny branch: mark the session failed,
   * run finalization (since `handleTransportClosed` exits early on terminal
   * status), speak, then end after the play URL has been delivered.
   */
  private async preflightCredentialsThenGreet(
    session: ReturnType<typeof getCallSession>,
  ): Promise<void> {
    let readiness: Awaited<
      ReturnType<typeof resolveTelephonyCredentialReadiness>
    >;
    try {
      readiness = await resolveTelephonyCredentialReadiness();
    } catch (err) {
      // Treat a preflight error as ready so a transient config-read failure
      // doesn't hang up an otherwise-valid call; downstream synthesis/STT
      // already degrade safely (TTS via the playability guard).
      log.error(
        { err, callSessionId: this.callSessionId },
        "Telephony credential preflight threw — proceeding with call setup",
      );
      readiness = { status: "ready" };
    }

    if (readiness.status === "not-ready") {
      const summary = describeCredentialGaps(readiness.missing);
      log.warn(
        { callSessionId: this.callSessionId, missing: readiness.missing },
        "Inbound media-stream call blocked by telephony credential preflight",
      );

      // Tear down the controller bootstrapped synchronously above before its
      // greeting can attempt (silent) synthesis.
      if (this.controller) {
        this.controller.destroy();
        this.controller = null;
        unregisterCallController(this.callSessionId);
      }

      recordCallEvent(
        this.callSessionId,
        "telephony_credential_preflight_failed",
        {
          direction: "inbound",
          missing: readiness.missing,
          transport: "media-stream",
        },
      );
      updateCallSession(this.callSessionId, {
        status: "failed",
        endedAt: Date.now(),
        lastError: `Telephony credential preflight failed: ${summary}`,
      });
      // Run finalization now because handleTransportClosed will see terminal
      // status and exit early when the WebSocket closes.
      this.runFinalizationAndGrantCleanup(session);
      void speakSystemPrompt(
        this.output,
        "Sorry, this assistant isn't set up to take calls right now. Please try again later. Goodbye.",
      ).finally(() => {
        setTimeout(
          () =>
            this.output.endSession(`Credential preflight failed: ${summary}`),
          3000,
        );
      });
      return;
    }

    // Ready — fire the initial greeting on the already-registered controller.
    if (!this.controller) return;
    this.controller.startInitialGreeting().catch((err) => {
      log.error(
        { err, callSessionId: this.callSessionId },
        "Failed to start initial greeting on media-stream session",
      );
    });
  }

  // ── Finalization helper for early-teardown paths ─────────────────

  /**
   * Run scoped-grant revocation and call finalization inline. Used by
   * the deny and unsupported-flow branches which set terminal status
   * before `endSession()`. When the WebSocket subsequently closes,
   * {@link handleTransportClosed} sees the terminal status and exits
   * early — so we must perform cleanup here to avoid leaking grants
   * and skipping `finalizeCall()` side-effects.
   */
  private runFinalizationAndGrantCleanup(
    session: ReturnType<typeof getCallSession>,
  ): void {
    try {
      revokeScopedApprovalGrantsForContext({
        callSessionId: this.callSessionId,
      });
      if (session?.conversationId) {
        revokeScopedApprovalGrantsForContext({
          conversationId: session.conversationId,
        });
      }
    } catch (err) {
      log.warn(
        { err, callSessionId: this.callSessionId },
        "Failed to revoke scoped grants on early teardown path",
      );
    }

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
    // clearAudio runs BEFORE handleBargeIn so that the end-of-turn mark
    // enqueued by handleInterrupt (called within handleBargeIn) is not
    // wiped by the queue flush.
    if (this.output && this.controller) {
      this.output.clearAudio();
      const accepted = this.controller.handleBargeIn();
      if (accepted) {
        this.bargeInAccepted++;
        log.info(
          { callSessionId: this.callSessionId },
          "Media-stream barge-in accepted — cleared outbound audio",
        );
      } else {
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
    this.transcriptFinalsProduced++;

    // While the deterministic setup flow is active, finalized transcripts are
    // its input (name capture, spoken verification digits, in-wait utterances),
    // not conversational turns. Route them there and stop.
    if (this.setupFlow) {
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
    log.info(
      { callSessionId: this.callSessionId, digit },
      "DTMF digit received on media-stream",
    );
    recordCallEvent(this.callSessionId, "caller_spoke", {
      dtmfDigit: digit,
      transport: "media-stream",
    });

    // DTMF only carries meaning during the setup phase (verification / invite
    // code entry). Once the conversation is live there is no DTMF sub-flow, so
    // the digit is recorded for diagnostics and otherwise ignored.
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
