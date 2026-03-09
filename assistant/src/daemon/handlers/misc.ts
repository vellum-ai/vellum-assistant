import * as net from "node:net";

import { v4 as uuid } from "uuid";

import { getConfig } from "../../config/loader.js";
import {
  addMessage,
  createConversation,
  deleteConversation,
  getMessages,
} from "../../memory/conversation-crud.js";
import {
  GENERATING_TITLE,
  queueGenerateConversationTitle,
} from "../../memory/conversation-title-service.js";
import { getConfiguredProvider } from "../../providers/provider-send-message.js";
import type { Provider } from "../../providers/types.js";
import { checkIngressForSecrets } from "../../security/secret-ingress.js";
import { parseSlashCandidate } from "../../skills/slash-commands.js";
import { classifyInteraction } from "../classifier.js";
import { getAssistantName } from "../identity-helpers.js";
import type {
  CuSessionCreate,
  LinkOpenRequest,
  SuggestionRequest,
  TaskSubmit,
} from "../ipc-protocol.js";
import { executeRecordingIntent } from "../recording-executor.js";
import { resolveRecordingIntent } from "../recording-intent.js";
import {
  classifyRecordingIntentFallback,
  containsRecordingKeywords,
} from "../recording-intent-fallback.js";
import {
  buildSessionErrorMessage,
  classifySessionError,
} from "../session-error.js";
import { handleCuSessionCreate } from "./computer-use.js";
import {
  handleRecordingPause,
  handleRecordingRestart,
  handleRecordingResume,
  handleRecordingStart,
  handleRecordingStop,
  isRecordingIdle,
} from "./recording.js";
import {
  defineHandlers,
  type HandlerContext,
  log,
  renderHistoryContent,
  wireEscalationHandler,
} from "./shared.js";

// ─── Task submit handler ────────────────────────────────────────────────────

export async function handleTaskSubmit(
  msg: TaskSubmit,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const requestId = uuid();
  const rlog = log.child({ requestId });

  try {
    // Block inbound tasks that contain secrets and redirect to secure prompt
    const taskIngressCheck = checkIngressForSecrets(msg.task);
    if (taskIngressCheck.blocked) {
      rlog.warn(
        { detectedTypes: taskIngressCheck.detectedTypes },
        "Blocked task_submit containing secrets",
      );
      ctx.send(socket, {
        type: "error",
        message: taskIngressCheck.userNotice!,
      });
      // Create an ephemeral session so the secret_response lifecycle works
      // end-to-end. The conversation is deleted after the prompt resolves
      // to avoid accumulating placeholder entries in session history.
      const conversation = createConversation("(blocked — secret detected)");
      ctx.socketToSession.set(socket, conversation.id);
      const session = await ctx.getOrCreateSession(
        conversation.id,
        socket,
        true,
      );
      session.redirectToSecurePrompt(taskIngressCheck.detectedTypes, {
        onComplete: () => {
          deleteConversation(conversation.id);
          // Clean up in-memory session and socket binding so the ephemeral
          // session doesn't accumulate in the daemon's session map.
          const s = ctx.sessions.get(conversation.id);
          if (s) {
            s.dispose();
            ctx.sessions.delete(conversation.id);
          }
          // Only unbind if the socket still points to this ephemeral conversation;
          // a new task_submit may have already rebound it to a real session.
          if (ctx.socketToSession.get(socket) === conversation.id) {
            ctx.socketToSession.delete(socket);
          }
        },
      });
      return;
    }

    // ── Structured command intent (bypasses text parsing) ──────────────────
    const config = getConfig();
    if (
      config.daemon.standaloneRecording &&
      msg.commandIntent?.domain === "screen_recording"
    ) {
      const action = msg.commandIntent.action;
      rlog.info(
        { action, source: "commandIntent" },
        "Recording command intent received",
      );
      if (action === "start") {
        const conversation = createConversation(msg.task || "Screen Recording");
        ctx.socketToSession.set(socket, conversation.id);
        const recordingId = handleRecordingStart(
          conversation.id,
          { promptForSource: true },
          socket,
          ctx,
        );
        const responseText = recordingId
          ? "Starting screen recording."
          : "A recording is already active.";
        ctx.send(socket, {
          type: "task_routed",
          sessionId: conversation.id,
          interactionType: "text_qa",
        });
        ctx.send(socket, {
          type: "assistant_text_delta",
          text: responseText,
          sessionId: conversation.id,
        });
        ctx.send(socket, {
          type: "message_complete",
          sessionId: conversation.id,
        });
        await addMessage(
          conversation.id,
          "user",
          JSON.stringify([{ type: "text", text: msg.task || "" }]),
        );
        await addMessage(
          conversation.id,
          "assistant",
          JSON.stringify([{ type: "text", text: responseText }]),
        );
        // Sync in-memory session if one exists for this conversation
        const startSession = ctx.sessions.get(conversation.id);
        if (startSession && !startSession.isProcessing()) {
          startSession.messages.push({
            role: "user",
            content: [{ type: "text", text: msg.task || "" }],
          });
          startSession.messages.push({
            role: "assistant",
            content: [{ type: "text", text: responseText }],
          });
        }
        if (!recordingId) ctx.socketToSession.delete(socket);
        return;
      } else if (action === "stop") {
        let activeSessionId = ctx.socketToSession.get(socket);
        if (!activeSessionId) {
          const conversation = createConversation(msg.task || "Stop Recording");
          activeSessionId = conversation.id;
          ctx.socketToSession.set(socket, activeSessionId);
        }
        const stopped = handleRecordingStop(activeSessionId, ctx) !== undefined;
        const responseText = stopped
          ? "Stopping the recording."
          : "No active recording to stop.";
        ctx.send(socket, {
          type: "task_routed",
          sessionId: activeSessionId,
          interactionType: "text_qa",
        });
        ctx.send(socket, {
          type: "assistant_text_delta",
          text: responseText,
          sessionId: activeSessionId,
        });
        ctx.send(socket, {
          type: "message_complete",
          sessionId: activeSessionId,
        });
        await addMessage(
          activeSessionId,
          "user",
          JSON.stringify([{ type: "text", text: msg.task || "" }]),
        );
        await addMessage(
          activeSessionId,
          "assistant",
          JSON.stringify([{ type: "text", text: responseText }]),
        );
        const stopSession = ctx.sessions.get(activeSessionId);
        if (stopSession && !stopSession.isProcessing()) {
          stopSession.messages.push({
            role: "user",
            content: [{ type: "text", text: msg.task || "" }],
          });
          stopSession.messages.push({
            role: "assistant",
            content: [{ type: "text", text: responseText }],
          });
        }
        return;
      } else if (action === "restart") {
        let activeSessionId = ctx.socketToSession.get(socket);
        if (!activeSessionId) {
          const conversation = createConversation(
            msg.task || "Restart Recording",
          );
          activeSessionId = conversation.id;
          ctx.socketToSession.set(socket, activeSessionId);
        }
        const restartResult = handleRecordingRestart(
          activeSessionId,
          socket,
          ctx,
        );
        ctx.send(socket, {
          type: "task_routed",
          sessionId: activeSessionId,
          interactionType: "text_qa",
        });
        ctx.send(socket, {
          type: "assistant_text_delta",
          text: restartResult.responseText,
          sessionId: activeSessionId,
        });
        ctx.send(socket, {
          type: "message_complete",
          sessionId: activeSessionId,
        });
        await addMessage(
          activeSessionId,
          "user",
          JSON.stringify([{ type: "text", text: msg.task || "" }]),
        );
        await addMessage(
          activeSessionId,
          "assistant",
          JSON.stringify([{ type: "text", text: restartResult.responseText }]),
        );
        const restartSession = ctx.sessions.get(activeSessionId);
        if (restartSession && !restartSession.isProcessing()) {
          restartSession.messages.push({
            role: "user",
            content: [{ type: "text", text: msg.task || "" }],
          });
          restartSession.messages.push({
            role: "assistant",
            content: [{ type: "text", text: restartResult.responseText }],
          });
        }
        return;
      } else if (action === "pause") {
        let activeSessionId = ctx.socketToSession.get(socket);
        if (!activeSessionId) {
          const conversation = createConversation(
            msg.task || "Pause Recording",
          );
          activeSessionId = conversation.id;
          ctx.socketToSession.set(socket, activeSessionId);
        }
        const paused = handleRecordingPause(activeSessionId, ctx) !== undefined;
        const responseText = paused
          ? "Pausing the recording."
          : "No active recording to pause.";
        ctx.send(socket, {
          type: "task_routed",
          sessionId: activeSessionId,
          interactionType: "text_qa",
        });
        ctx.send(socket, {
          type: "assistant_text_delta",
          text: responseText,
          sessionId: activeSessionId,
        });
        ctx.send(socket, {
          type: "message_complete",
          sessionId: activeSessionId,
        });
        await addMessage(
          activeSessionId,
          "user",
          JSON.stringify([{ type: "text", text: msg.task || "" }]),
        );
        await addMessage(
          activeSessionId,
          "assistant",
          JSON.stringify([{ type: "text", text: responseText }]),
        );
        const pauseSession = ctx.sessions.get(activeSessionId);
        if (pauseSession && !pauseSession.isProcessing()) {
          pauseSession.messages.push({
            role: "user",
            content: [{ type: "text", text: msg.task || "" }],
          });
          pauseSession.messages.push({
            role: "assistant",
            content: [{ type: "text", text: responseText }],
          });
        }
        return;
      } else if (action === "resume") {
        let activeSessionId = ctx.socketToSession.get(socket);
        if (!activeSessionId) {
          const conversation = createConversation(
            msg.task || "Resume Recording",
          );
          activeSessionId = conversation.id;
          ctx.socketToSession.set(socket, activeSessionId);
        }
        const resumed =
          handleRecordingResume(activeSessionId, ctx) !== undefined;
        const responseText = resumed
          ? "Resuming the recording."
          : "No active recording to resume.";
        ctx.send(socket, {
          type: "task_routed",
          sessionId: activeSessionId,
          interactionType: "text_qa",
        });
        ctx.send(socket, {
          type: "assistant_text_delta",
          text: responseText,
          sessionId: activeSessionId,
        });
        ctx.send(socket, {
          type: "message_complete",
          sessionId: activeSessionId,
        });
        await addMessage(
          activeSessionId,
          "user",
          JSON.stringify([{ type: "text", text: msg.task || "" }]),
        );
        await addMessage(
          activeSessionId,
          "assistant",
          JSON.stringify([{ type: "text", text: responseText }]),
        );
        const resumeSession = ctx.sessions.get(activeSessionId);
        if (resumeSession && !resumeSession.isProcessing()) {
          resumeSession.messages.push({
            role: "user",
            content: [{ type: "text", text: msg.task || "" }],
          });
          resumeSession.messages.push({
            role: "assistant",
            content: [{ type: "text", text: responseText }],
          });
        }
        return;
      } else {
        // Unrecognized action — fall through to normal text handling so the
        // task is not silently dropped.
        rlog.warn(
          { action, source: "commandIntent" },
          "Unrecognized screen_recording action, falling through to text handling",
        );
      }
    }

    // ── Standalone recording intent interception ──────────────────────────
    let pendingRecordingStart = false;
    let pendingRecordingStop = false;
    let pendingRecordingRestart:
      | "restart_with_remainder"
      | "start_and_stop_with_remainder"
      | false = false;
    let originalTaskBeforeStrip: string | undefined;
    if (config.daemon.standaloneRecording) {
      const name = getAssistantName();
      const dynamicNames = [name].filter(Boolean) as string[];
      const intentResult = resolveRecordingIntent(msg.task, dynamicNames);

      if (intentResult.kind === "start_only") {
        // Create a conversation so the recording can be attached later
        const conversation = createConversation(msg.task);
        ctx.socketToSession.set(socket, conversation.id);

        const execResult = executeRecordingIntent(intentResult, {
          conversationId: conversation.id,
          socket,
          ctx,
        });

        ctx.send(socket, {
          type: "task_routed",
          sessionId: conversation.id,
          interactionType: "text_qa",
        });
        ctx.send(socket, {
          type: "assistant_text_delta",
          text: execResult.responseText!,
          sessionId: conversation.id,
        });
        ctx.send(socket, {
          type: "message_complete",
          sessionId: conversation.id,
        });
        await addMessage(
          conversation.id,
          "user",
          JSON.stringify([{ type: "text", text: msg.task || "" }]),
        );
        await addMessage(
          conversation.id,
          "assistant",
          JSON.stringify([{ type: "text", text: execResult.responseText! }]),
        );
        const startOnlySession = ctx.sessions.get(conversation.id);
        if (startOnlySession && !startOnlySession.isProcessing()) {
          startOnlySession.messages.push({
            role: "user",
            content: [{ type: "text", text: msg.task || "" }],
          });
          startOnlySession.messages.push({
            role: "assistant",
            content: [{ type: "text", text: execResult.responseText! }],
          });
        }

        // If recording rejected, unbind socket
        if (execResult.recordingStarted === false) {
          ctx.socketToSession.delete(socket);
        }

        rlog.info(
          { sessionId: conversation.id },
          "Recording-only intent intercepted — routed to standalone recording",
        );
        return;
      }

      if (intentResult.kind === "stop_only") {
        let activeSessionId = ctx.socketToSession.get(socket);
        if (!activeSessionId) {
          const conversation = createConversation(msg.task);
          activeSessionId = conversation.id;
          ctx.socketToSession.set(socket, activeSessionId);
        }

        const execResult = executeRecordingIntent(intentResult, {
          conversationId: activeSessionId,
          socket,
          ctx,
        });

        rlog.info("Recording stop intent intercepted");
        ctx.send(socket, {
          type: "task_routed",
          sessionId: activeSessionId,
          interactionType: "text_qa",
        });
        ctx.send(socket, {
          type: "assistant_text_delta",
          text: execResult.responseText!,
          sessionId: activeSessionId,
        });
        ctx.send(socket, {
          type: "message_complete",
          sessionId: activeSessionId,
        });
        await addMessage(
          activeSessionId,
          "user",
          JSON.stringify([{ type: "text", text: msg.task || "" }]),
        );
        await addMessage(
          activeSessionId,
          "assistant",
          JSON.stringify([{ type: "text", text: execResult.responseText! }]),
        );
        const stopOnlySession = ctx.sessions.get(activeSessionId);
        if (stopOnlySession && !stopOnlySession.isProcessing()) {
          stopOnlySession.messages.push({
            role: "user",
            content: [{ type: "text", text: msg.task || "" }],
          });
          stopOnlySession.messages.push({
            role: "assistant",
            content: [{ type: "text", text: execResult.responseText! }],
          });
        }
        return;
      }

      if (intentResult.kind === "start_and_stop_only") {
        let activeSessionId = ctx.socketToSession.get(socket);
        if (!activeSessionId) {
          const conversation = createConversation(msg.task);
          activeSessionId = conversation.id;
          ctx.socketToSession.set(socket, activeSessionId);
        }

        const execResult = executeRecordingIntent(intentResult, {
          conversationId: activeSessionId,
          socket,
          ctx,
        });

        rlog.info("Recording start+stop intent intercepted");
        ctx.send(socket, {
          type: "task_routed",
          sessionId: activeSessionId,
          interactionType: "text_qa",
        });
        ctx.send(socket, {
          type: "assistant_text_delta",
          text: execResult.responseText!,
          sessionId: activeSessionId,
        });
        ctx.send(socket, {
          type: "message_complete",
          sessionId: activeSessionId,
        });
        await addMessage(
          activeSessionId,
          "user",
          JSON.stringify([{ type: "text", text: msg.task || "" }]),
        );
        await addMessage(
          activeSessionId,
          "assistant",
          JSON.stringify([{ type: "text", text: execResult.responseText! }]),
        );
        const startStopOnlySession = ctx.sessions.get(activeSessionId);
        if (startStopOnlySession && !startStopOnlySession.isProcessing()) {
          startStopOnlySession.messages.push({
            role: "user",
            content: [{ type: "text", text: msg.task || "" }],
          });
          startStopOnlySession.messages.push({
            role: "assistant",
            content: [{ type: "text", text: execResult.responseText! }],
          });
        }
        return;
      }

      // Restart/pause/resume — fully handled intents
      if (
        intentResult.kind === "restart_only" ||
        intentResult.kind === "pause_only" ||
        intentResult.kind === "resume_only"
      ) {
        let activeSessionId = ctx.socketToSession.get(socket);
        if (!activeSessionId) {
          const conversation = createConversation(msg.task);
          activeSessionId = conversation.id;
          ctx.socketToSession.set(socket, activeSessionId);
        }

        const execResult = executeRecordingIntent(intentResult, {
          conversationId: activeSessionId,
          socket,
          ctx,
        });

        rlog.info({ kind: intentResult.kind }, "Recording intent intercepted");
        ctx.send(socket, {
          type: "task_routed",
          sessionId: activeSessionId,
          interactionType: "text_qa",
        });
        ctx.send(socket, {
          type: "assistant_text_delta",
          text: execResult.responseText!,
          sessionId: activeSessionId,
        });
        ctx.send(socket, {
          type: "message_complete",
          sessionId: activeSessionId,
        });
        await addMessage(
          activeSessionId,
          "user",
          JSON.stringify([{ type: "text", text: msg.task || "" }]),
        );
        await addMessage(
          activeSessionId,
          "assistant",
          JSON.stringify([{ type: "text", text: execResult.responseText! }]),
        );
        const handledSession = ctx.sessions.get(activeSessionId);
        if (handledSession && !handledSession.isProcessing()) {
          handledSession.messages.push({
            role: "user",
            content: [{ type: "text", text: msg.task || "" }],
          });
          handledSession.messages.push({
            role: "assistant",
            content: [{ type: "text", text: execResult.responseText! }],
          });
        }
        return;
      }

      if (
        intentResult.kind === "start_with_remainder" ||
        intentResult.kind === "stop_with_remainder" ||
        intentResult.kind === "start_and_stop_with_remainder" ||
        intentResult.kind === "restart_with_remainder"
      ) {
        // Defer recording action until after classifier creates the final conversation
        pendingRecordingStop = intentResult.kind === "stop_with_remainder";
        // start_and_stop_with_remainder is semantically a restart — route through
        // handleRecordingRestart which properly cleans up maps between stop and start.
        // However, when there's no active recording the stop is a no-op, so fall
        // back to a plain start instead of restart.
        if (intentResult.kind === "start_and_stop_with_remainder") {
          if (isRecordingIdle()) {
            pendingRecordingStart = true;
          } else {
            pendingRecordingRestart = "start_and_stop_with_remainder";
          }
        } else {
          pendingRecordingStart = intentResult.kind === "start_with_remainder";
          pendingRecordingRestart =
            intentResult.kind === "restart_with_remainder"
              ? "restart_with_remainder"
              : false;
        }
        // Preserve the original text so the DB stores the full message
        originalTaskBeforeStrip = msg.task;
        (msg as { task: string }).task = intentResult.remainder;
        rlog.info(
          { remaining: intentResult.remainder },
          "Recording intent deferred, continuing with remaining text",
        );
      }

      // 'none' — deterministic resolver found nothing; try LLM fallback
      // if the text contains recording-related keywords.
      if (intentResult.kind === "none" && containsRecordingKeywords(msg.task)) {
        const fallback = await classifyRecordingIntentFallback(msg.task);
        rlog.info(
          {
            fallbackAction: fallback.action,
            fallbackConfidence: fallback.confidence,
          },
          "Recording intent LLM fallback result",
        );

        if (fallback.action !== "none" && fallback.confidence === "high") {
          const kindMap: Record<
            string,
            import("../recording-intent.js").RecordingIntentResult
          > = {
            start: { kind: "start_only" },
            stop: { kind: "stop_only" },
            restart: { kind: "restart_only" },
            pause: { kind: "pause_only" },
            resume: { kind: "resume_only" },
          };
          const mapped = kindMap[fallback.action];
          if (mapped) {
            let activeSessionId = ctx.socketToSession.get(socket);
            if (!activeSessionId) {
              const conversation = createConversation(msg.task);
              activeSessionId = conversation.id;
              ctx.socketToSession.set(socket, activeSessionId);
            }

            const execResult = executeRecordingIntent(mapped, {
              conversationId: activeSessionId,
              socket,
              ctx,
            });

            if (execResult.handled) {
              rlog.info(
                { kind: mapped.kind, source: "llm_fallback" },
                "Recording intent intercepted via LLM fallback",
              );
              ctx.send(socket, {
                type: "task_routed",
                sessionId: activeSessionId,
                interactionType: "text_qa",
              });
              ctx.send(socket, {
                type: "assistant_text_delta",
                text: execResult.responseText!,
                sessionId: activeSessionId,
              });
              ctx.send(socket, {
                type: "message_complete",
                sessionId: activeSessionId,
              });
              await addMessage(
                activeSessionId,
                "user",
                JSON.stringify([{ type: "text", text: msg.task || "" }]),
              );
              await addMessage(
                activeSessionId,
                "assistant",
                JSON.stringify([
                  { type: "text", text: execResult.responseText! },
                ]),
              );
              const fallbackSession = ctx.sessions.get(activeSessionId);
              if (fallbackSession && !fallbackSession.isProcessing()) {
                fallbackSession.messages.push({
                  role: "user",
                  content: [{ type: "text", text: msg.task || "" }],
                });
                fallbackSession.messages.push({
                  role: "assistant",
                  content: [{ type: "text", text: execResult.responseText! }],
                });
              }

              // If recording was rejected (e.g. already active), unbind the
              // socket so it doesn't stay bound to an orphaned conversation.
              if (execResult.recordingStarted === false) {
                ctx.socketToSession.delete(socket);
              }
              return;
            }
          }
        }
      }
    }

    // Slash candidates always route to text_qa — bypass classifier
    const slashCandidate = parseSlashCandidate(msg.task);
    const interactionType =
      slashCandidate.kind === "candidate"
        ? ("text_qa" as const)
        : await classifyInteraction(msg.task, msg.source);
    rlog.info(
      {
        interactionType,
        slashBypass: slashCandidate.kind === "candidate",
        taskLength: msg.task.length,
      },
      "Task classified",
    );

    if (interactionType === "computer_use") {
      // Create CU session (reuse handleCuSessionCreate logic)
      const sessionId = uuid();
      const cuMsg: CuSessionCreate = {
        type: "cu_session_create",
        sessionId,
        task: msg.task,
        screenWidth: msg.screenWidth,
        screenHeight: msg.screenHeight,
        attachments: msg.attachments,
        interactionType: "computer_use",
      };
      handleCuSessionCreate(cuMsg, socket, ctx);

      // Start deferred recording from mixed intent (create a DB conversation
      // for the recording attachment since CU sessions don't have one).
      if (
        pendingRecordingStart ||
        pendingRecordingStop ||
        pendingRecordingRestart
      ) {
        const recConversation = createConversation("Screen Recording");
        if (pendingRecordingStop) handleRecordingStop(recConversation.id, ctx);
        if (pendingRecordingStart)
          handleRecordingStart(
            recConversation.id,
            { promptForSource: true },
            socket,
            ctx,
          );
        if (pendingRecordingRestart) {
          const restartResult = handleRecordingRestart(
            recConversation.id,
            socket,
            ctx,
          );
          // TOCTOU: recording may have stopped between intent resolution and
          // deferred execution. Fall back to plain start for stop-and-start
          // intents (user wants a new recording), but not for pure restart.
          if (
            !restartResult.initiated &&
            restartResult.reason === "no_active_recording" &&
            pendingRecordingRestart === "start_and_stop_with_remainder"
          ) {
            handleRecordingStart(
              recConversation.id,
              { promptForSource: true },
              socket,
              ctx,
            );
          }
        }
      }

      ctx.send(socket, {
        type: "task_routed",
        sessionId,
        interactionType: "computer_use",
      });
    } else {
      // Create text QA session and immediately start processing
      const conversation = createConversation(GENERATING_TITLE);
      queueGenerateConversationTitle({
        conversationId: conversation.id,
        context: { origin: "task_submit" },
        userMessage: msg.task,
      });
      ctx.socketToSession.set(socket, conversation.id);
      const session = await ctx.getOrCreateSession(
        conversation.id,
        socket,
        true,
      );

      // Wire escalation handler so the agent can call computer_use_request_control
      wireEscalationHandler(
        session,
        socket,
        ctx,
        msg.screenWidth,
        msg.screenHeight,
      );

      // Start deferred recording from mixed intent, now using the real conversation
      if (pendingRecordingStop) handleRecordingStop(conversation.id, ctx);
      if (pendingRecordingStart)
        handleRecordingStart(
          conversation.id,
          { promptForSource: true },
          socket,
          ctx,
        );
      if (pendingRecordingRestart) {
        const restartResult = handleRecordingRestart(
          conversation.id,
          socket,
          ctx,
        );
        if (
          !restartResult.initiated &&
          restartResult.reason === "no_active_recording" &&
          pendingRecordingRestart === "start_and_stop_with_remainder"
        ) {
          handleRecordingStart(
            conversation.id,
            { promptForSource: true },
            socket,
            ctx,
          );
        }
      }

      ctx.send(socket, {
        type: "task_routed",
        sessionId: conversation.id,
        interactionType: "text_qa",
      });

      // Start streaming immediately — client doesn't need to send user_message
      session
        .processMessage(
          msg.task,
          msg.attachments ?? [],
          (event) => {
            ctx.send(socket, event);
          },
          requestId,
          undefined,
          undefined,
          undefined,
          originalTaskBeforeStrip,
        )
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          rlog.error({ err }, "Error processing task_submit text QA");
          ctx.send(socket, {
            type: "error",
            message: `Failed to process message: ${message}`,
          });
          const classified = classifySessionError(err, { phase: "agent_loop" });
          ctx.send(
            socket,
            buildSessionErrorMessage(conversation.id, classified),
          );
        });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rlog.error({ err }, "Error handling task_submit");
    ctx.send(socket, {
      type: "error",
      message: `Failed to route task: ${message}`,
    });
  }
}

// ─── Suggestion handler ─────────────────────────────────────────────────────

const SUGGESTION_CACHE_MAX = 100;
const suggestionCache = new Map<string, string>();
const suggestionInFlight = new Map<string, Promise<string | null>>();

export async function handleSuggestionRequest(
  msg: SuggestionRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): Promise<void> {
  const noSuggestion = () => {
    ctx.send(socket, {
      type: "suggestion_response",
      requestId: msg.requestId,
      suggestion: null,
      source: "none" as const,
    });
  };

  const rawMessages = getMessages(msg.sessionId);
  if (rawMessages.length === 0) {
    noSuggestion();
    return;
  }

  // Find the most recent assistant message — only use it if it has text content.
  // Do NOT fall back to older turns; if the latest assistant message is tool-only,
  // return no suggestion rather than reusing stale text from a previous turn.
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const m = rawMessages[i];
    if (m.role !== "assistant") continue;

    let content: unknown;
    try {
      content = JSON.parse(m.content);
    } catch {
      content = m.content;
    }
    const rendered = renderHistoryContent(content);
    const text = rendered.text.trim();
    if (!text) {
      noSuggestion();
      return;
    }

    // Return cached suggestion
    const cached = suggestionCache.get(m.id);
    if (cached !== undefined) {
      ctx.send(socket, {
        type: "suggestion_response",
        requestId: msg.requestId,
        suggestion: cached,
        source: "llm" as const,
      });
      return;
    }

    // Try LLM suggestion using the configured provider
    const provider = getConfiguredProvider();
    if (provider) {
      try {
        let promise = suggestionInFlight.get(m.id);
        if (!promise) {
          promise = generateSuggestion(provider, text);
          suggestionInFlight.set(m.id, promise);
        }
        const llmSuggestion = await promise;
        suggestionInFlight.delete(m.id);

        if (llmSuggestion) {
          if (suggestionCache.size >= SUGGESTION_CACHE_MAX) {
            const oldest = suggestionCache.keys().next().value!;
            suggestionCache.delete(oldest);
          }
          suggestionCache.set(m.id, llmSuggestion);

          ctx.send(socket, {
            type: "suggestion_response",
            requestId: msg.requestId,
            suggestion: llmSuggestion,
            source: "llm" as const,
          });
          return;
        }
      } catch (err) {
        suggestionInFlight.delete(m.id);
        log.warn({ err }, "LLM suggestion failed");
      }
    }

    noSuggestion();
    return;
  }

  noSuggestion();
}

async function generateSuggestion(
  provider: Provider,
  assistantText: string,
): Promise<string | null> {
  const truncated =
    assistantText.length > 2000 ? assistantText.slice(-2000) : assistantText;

  const prompt = `Given this assistant message, write a very short tab-complete suggestion (max 50 chars) the user could send next to keep the conversation going. Be casual, curious, or actionable — like a quick reply, not a formal request. Reply with ONLY the suggestion text.\n\nAssistant's message:\n${truncated}`;
  const response = await provider.sendMessage(
    [{ role: "user", content: [{ type: "text", text: prompt }] }],
    [], // no tools
    undefined, // no system prompt
    { config: { max_tokens: 30 } },
  );

  const textBlock = response.content.find((b) => b.type === "text");
  const raw = textBlock && "text" in textBlock ? textBlock.text.trim() : "";
  if (!raw || raw.length > 50) return null;

  const firstLine = raw.split("\n")[0].trim();
  return firstLine || null;
}

// ─── Link open handler ──────────────────────────────────────────────────────

export function handleLinkOpenRequest(
  msg: LinkOpenRequest,
  socket: net.Socket,
  ctx: HandlerContext,
): void {
  try {
    const parsed = new URL(msg.url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      log.warn({ url: msg.url }, "link_open_request: blocked non-http URL");
      return;
    }
  } catch {
    log.warn({ url: msg.url }, "link_open_request: invalid URL");
    return;
  }
  // V1: passthrough. Future: affiliate param injection based on metadata
  const finalUrl = msg.url;
  ctx.send(socket, { type: "open_url", url: finalUrl });
}

export const miscHandlers = defineHandlers({
  task_submit: handleTaskSubmit,
  suggestion_request: handleSuggestionRequest,
  link_open_request: handleLinkOpenRequest,
  ping: (_msg, socket, ctx) => {
    ctx.send(socket, { type: "pong" });
  },
});
