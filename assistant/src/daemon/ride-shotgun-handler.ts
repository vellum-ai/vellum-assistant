import { randomUUID } from "node:crypto";

import { autoNavigate } from "../tools/browser/auto-navigate.js";
import {
  type CdpSession,
  ensureChromeWithCdp,
  minimizeChromeWindow,
} from "../tools/browser/chrome-cdp.js";
import { NetworkRecorder } from "../tools/browser/network-recorder.js";
import type { SessionRecording } from "../tools/browser/network-recording-types.js";
import { saveRecording } from "../tools/browser/recording-store.js";
import { navigateXPages } from "../tools/browser/x-auto-navigate.js";
import type { WatchSession } from "../tools/watch/watch-state.js";
import {
  fireWatchCompletionNotifier,
  fireWatchStartNotifier,
  registerWatchCompletionNotifier,
  unregisterWatchCompletionNotifier,
  watchSessions,
} from "../tools/watch/watch-state.js";
import { getLogger } from "../util/logger.js";
import type { HandlerContext } from "./handlers/shared.js";
import type { RideShotgunStart, RideShotgunStop } from "./message-protocol.js";
import { generateSummary, lastSummaryBySession } from "./watch-handler.js";

const log = getLogger("ride-shotgun-handler");

/** Active network recorders keyed by watchId. */
const activeRecorders = new Map<string, NetworkRecorder>();

/** Active CDP sessions keyed by watchId — tracks browser ownership for cleanup. */
const activeCdpSessions = new Map<string, CdpSession>();

/** Active progress interval timers keyed by watchId, cleared on session completion. */
const activeProgressIntervals = new Map<string, NodeJS.Timeout>();

/** Return domain-specific URL patterns that indicate a successful login. */
function getLoginSignals(targetDomain?: string): string[] {
  if (targetDomain === "x.com" || targetDomain === "twitter.com") {
    return [
      "/i/api/graphql/", // any authenticated GraphQL call
      "/1.1/account/settings", // legacy API session check
    ];
  }
  // DoorDash and general fallback
  return [
    "/graphql/postLoginQuery",
    "/graphql/homePageFacetFeed",
    "/graphql/getConsumerOrdersWithDetails",
  ];
}

/**
 * Complete a session — finalize recording (if learn mode), generate summary, fire notifier.
 * Shared by both the duration timeout and the early-stop handler.
 */
async function completeSession(session: WatchSession): Promise<void> {
  if (session.status !== "active") return; // already completing/completed

  session.status = "completing";
  if (session.timeoutHandle) {
    clearTimeout(session.timeoutHandle);
    session.timeoutHandle = undefined;
  }

  // Clear progress interval timer if one was registered for this session
  const progressTimer = activeProgressIntervals.get(session.watchId);
  if (progressTimer) {
    clearInterval(progressTimer);
    activeProgressIntervals.delete(session.watchId);
  }

  const { watchId, sessionId } = session;
  log.info(
    { watchId, sessionId, observationCount: session.observations.length },
    "Session completing...",
  );

  // In learn mode, stop recording and save — skip the LLM summary (not needed)
  if (session.isLearnMode && session.recordingId) {
    const hasRecorder = activeRecorders.has(watchId);

    if (hasRecorder) {
      session.savedRecordingPath = await finalizeLearnRecording(
        watchId,
        session,
        session.recordingId,
      );
    }

    // Clean up the CDP session — minimize if we launched Chrome, leave it alone otherwise
    const cdpSession = activeCdpSessions.get(watchId);
    if (cdpSession) {
      activeCdpSessions.delete(watchId);
      if (cdpSession.launchedByUs) {
        try {
          await minimizeChromeWindow(cdpSession.baseUrl);
          log.info({ watchId }, "Minimized assistant-launched Chrome window");
        } catch (err) {
          log.debug({ err, watchId }, "Failed to minimize Chrome window");
        }
      }
    }

    // Use bootstrapFailureReason as the primary discriminator — hasRecorder
    // alone can't distinguish "browser never launched" from "recorder failed
    // after retries" since both leave activeRecorders empty.
    const summary = session.bootstrapFailureReason
      ? `Learn session failed — ${session.bootstrapFailureReason}`
      : session.savedRecordingPath
        ? "Learn session completed — recording saved."
        : "Learn session completed — recording failed to save.";

    lastSummaryBySession.set(sessionId, summary);
    session.status = "completed";
    log.info(
      {
        watchId,
        sessionId,
        hasRecorder,
        bootstrapFailureReason: session.bootstrapFailureReason,
      },
      "Learn session complete — firing completion notifier",
    );
    fireWatchCompletionNotifier(sessionId, session);
    log.info({ watchId, sessionId }, "Completion notifier fired");
    return;
  }

  await generateSummary(session);
  session.status = "completed";
}

export async function handleRideShotgunStart(
  msg: RideShotgunStart,
  ctx: HandlerContext,
): Promise<void> {
  const watchId = randomUUID();
  const sessionId = randomUUID();
  const { durationSeconds, intervalSeconds } = msg;
  const mode = msg.mode ?? "observe";
  const targetDomain = msg.targetDomain;
  const isLearnMode = mode === "learn";
  const recordingId = isLearnMode ? randomUUID() : undefined;

  const session: WatchSession = {
    watchId,
    sessionId,
    focusArea: isLearnMode
      ? `Learn mode: recording network traffic and screen observations${
          targetDomain ? ` for ${targetDomain}` : ""
        }`
      : "General workflow observation",
    durationSeconds,
    intervalSeconds,
    observations: [],
    commentaryCount: 0,
    status: "active",
    startedAt: Date.now(),
    isRideShotgun: true,
    isLearnMode,
    targetDomain,
    recordingId,
  };

  watchSessions.set(watchId, session);
  log.debug(
    {
      watchId,
      sessionId,
      durationSeconds,
      intervalSeconds,
      mode,
      targetDomain,
    },
    "Session created and stored in watchSessions map",
  );

  // In learn mode, ensure Chrome is available with CDP, then connect for network recording.
  if (isLearnMode) {
    const startRecording = async () => {
      // Ensure Chrome is running with CDP — launches it if needed
      let cdpSession: CdpSession;
      try {
        cdpSession = await ensureChromeWithCdp({
          startUrl: targetDomain ? `https://${targetDomain}` : undefined,
        });
        // If session completed while we were awaiting Chrome, skip storing to avoid a stale map entry
        if (session.status !== "active") {
          log.info(
            { watchId, status: session.status },
            "Session no longer active after CDP launch — skipping recording",
          );
          // If we launched Chrome, minimize it since completeSession already ran and won't find it
          if (cdpSession.launchedByUs) {
            try {
              await minimizeChromeWindow(cdpSession.baseUrl);
              log.info(
                { watchId },
                "Minimized assistant-launched Chrome window (post-session)",
              );
            } catch (err) {
              log.debug(
                { err, watchId },
                "Failed to minimize Chrome window (post-session)",
              );
            }
          }
          return;
        }
        activeCdpSessions.set(watchId, cdpSession);
        log.info(
          {
            watchId,
            launchedByUs: cdpSession.launchedByUs,
            baseUrl: cdpSession.baseUrl,
          },
          "CDP session established",
        );
      } catch (err) {
        log.warn(
          { err, watchId },
          "Failed to ensure Chrome with CDP — cannot start recording",
        );
        ctx.send({
          type: "ride_shotgun_error",
          watchId,
          sessionId,
          message:
            "Failed to start browser — Chrome CDP could not be launched.",
        });
        // Fail-fast: complete the session immediately instead of waiting for timeout
        session.bootstrapFailureReason = "browser could not be started.";
        await completeSession(session);
        return;
      }

      const cdpBaseUrl = cdpSession.baseUrl;

      for (let attempt = 0; attempt < 10; attempt++) {
        // Check if session is still active before each attempt
        if (session.status !== "active") {
          log.info(
            { watchId, attempt, status: session.status },
            "Session no longer active — aborting recording start",
          );
          return;
        }
        try {
          const recorder = new NetworkRecorder(targetDomain, cdpBaseUrl);
          recorder.loginSignals = getLoginSignals(targetDomain);
          await recorder.startDirect();
          // If session completed while we were connecting, stop immediately to avoid leak
          if (session.status !== "active") {
            log.info(
              { watchId, attempt },
              "Session completed during CDP connect — stopping recorder to prevent leak",
            );
            await recorder.stop();
            return;
          }
          activeRecorders.set(watchId, recorder);
          log.info(
            { watchId, targetDomain, attempt },
            "Network recording started for learn session",
          );

          // Send periodic progress updates with network entry counts and idle detection
          let lastNetworkEntryCount = 0;
          let lastActivityTimestamp = Date.now();
          let idleHintSent = false;

          const progressInterval: NodeJS.Timeout = setInterval(() => {
            if (session.status !== "active") {
              clearInterval(progressInterval);
              return;
            }

            const currentCount = recorder.entryCount;

            // Track activity: reset idle timer when count changes
            if (currentCount !== lastNetworkEntryCount) {
              lastNetworkEntryCount = currentCount;
              lastActivityTimestamp = Date.now();
              // If we previously sent an idle hint, clear it now that activity resumed
              if (idleHintSent) {
                idleHintSent = false;
                log.info(
                  { watchId, currentCount },
                  "Activity resumed — clearing idleHint",
                );
                ctx.send({
                  type: "ride_shotgun_progress",
                  watchId,
                  message: `Recording network traffic...`,
                  networkEntryCount: currentCount,
                  statusMessage: "Recording network traffic...",
                  idleHint: false,
                });
                return;
              }
            }

            // Idle detection: if some initial activity happened and no new entries for 15s, hint once
            const idleMs = Date.now() - lastActivityTimestamp;
            let idleHint: boolean | undefined;
            if (!idleHintSent && currentCount > 0 && idleMs >= 15_000) {
              idleHint = true;
              idleHintSent = true;
              log.info(
                { watchId, currentCount, idleMs },
                "Idle detected — sending idleHint",
              );
            }

            ctx.send({
              type: "ride_shotgun_progress",
              watchId,
              message: `Recording network traffic...`,
              networkEntryCount: currentCount,
              statusMessage: "Recording network traffic...",
              ...(idleHint !== undefined ? { idleHint } : {}),
            });
          }, 5000);
          activeProgressIntervals.set(watchId, progressInterval);

          // For x.com, auto-navigate Chrome through key pages to capture the full API surface.
          // Skip login detection — auto-navigation will complete the session when done.
          if (
            (targetDomain === "x.com" || targetDomain === "twitter.com") &&
            msg.autoNavigate !== false
          ) {
            // Don't set onLoginDetected — it would kill the session after the first
            // GraphQL call (5s grace), before auto-navigation finishes.
            const abortSignal = { aborted: false };
            const checkInterval = setInterval(() => {
              if (session.status !== "active") {
                abortSignal.aborted = true;
                clearInterval(checkInterval);
              }
            }, 1000);
            navigateXPages({ abortSignal, cdpBaseUrl })
              .then((completed) => {
                clearInterval(checkInterval);
                log.info(
                  { watchId, completedSteps: completed.length },
                  "X auto-navigation finished",
                );
                if (session.status === "active") {
                  completeSession(session);
                }
              })
              .catch((err) => {
                clearInterval(checkInterval);
                log.warn({ err, watchId }, "X auto-navigation failed");
                if (session.status === "active") {
                  completeSession(session);
                }
              });
          } else if (msg.autoNavigate && targetDomain) {
            const navDomain = msg.navigateDomain ?? targetDomain;
            const abortSignal = { aborted: false };
            const checkInterval = setInterval(() => {
              if (session.status !== "active") {
                abortSignal.aborted = true;
                clearInterval(checkInterval);
              }
            }, 1000);
            autoNavigate(navDomain, {
              abortSignal,
              onProgress: (progress) => {
                // Send progress to connected client
                if (progress.type === "visiting" && progress.url) {
                  const shortUrl = progress.url.replace(/^https?:\/\//, "");
                  ctx.send({
                    type: "ride_shotgun_progress",
                    watchId,
                    message: `[${progress.pageNumber || "?"}] ${shortUrl}`,
                  });
                }
              },
              cdpBaseUrl,
            })
              .then((visited) => {
                clearInterval(checkInterval);
                log.info(
                  { watchId, visitedPages: visited.length },
                  "Generic auto-navigation finished",
                );
                if (session.status === "active") {
                  completeSession(session);
                }
              })
              .catch((err) => {
                clearInterval(checkInterval);
                log.warn({ err, watchId }, "Generic auto-navigation failed");
                if (session.status === "active") {
                  completeSession(session);
                }
              });
          } else if (msg.autoNavigate === false && targetDomain) {
            // Manual mode: just record network traffic until timeout or early stop — no login detection shortcut.
          } else {
            // No targetDomain or targetDomain without explicit autoNavigate=false: use login detection
            recorder.onLoginDetected = () => {
              log.info(
                { watchId },
                "Login detected — auto-stopping learn session",
              );
              completeSession(session);
            };
          }

          return;
        } catch (err) {
          if (attempt < 9) {
            log.debug({ attempt, watchId }, "CDP not ready, retrying in 2s...");
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            log.warn(
              { err, watchId },
              "Failed to start network recording after 10 attempts",
            );
            ctx.send({
              type: "ride_shotgun_error",
              watchId,
              sessionId,
              message: "Failed to start network recording after 10 attempts.",
            });
            session.bootstrapFailureReason =
              "network recording could not be started after 10 attempts.";
            await completeSession(session);
          }
        }
      }
    };
    // Don't block session start — record in background
    startRecording();
  }

  // Set timeout for duration expiry
  session.timeoutHandle = setTimeout(() => {
    if (
      session.isLearnMode &&
      !activeRecorders.has(watchId) &&
      !session.bootstrapFailureReason
    ) {
      session.bootstrapFailureReason =
        "session timed out before recording could start.";
    }
    completeSession(session);
  }, durationSeconds * 1000);

  // Register completion notifier to send summary back to client
  registerWatchCompletionNotifier(
    sessionId,
    (_completedSession: WatchSession) => {
      const summary = lastSummaryBySession.get(sessionId) ?? "";
      const observationCount = _completedSession.observations.length;

      log.info(
        {
          watchId,
          sessionId,
          observationCount,
          summaryLength: summary.length,
        },
        "Completion notifier firing — sending ride_shotgun_result to client",
      );

      ctx.send({
        type: "ride_shotgun_result",
        sessionId,
        watchId,
        summary,
        observationCount,
        recordingId,
        recordingPath: _completedSession.savedRecordingPath,
      });

      unregisterWatchCompletionNotifier(sessionId);
      lastSummaryBySession.delete(sessionId);
      log.debug(
        { watchId, sessionId, observationCount, recordingId },
        "Ride shotgun result sent successfully",
      );
    },
  );

  // Fire start notifier
  fireWatchStartNotifier(sessionId, session);

  // Send watch_started so the Swift client knows the watchId/sessionId
  ctx.send({
    type: "watch_started",
    sessionId,
    watchId,
    durationSeconds,
    intervalSeconds,
  });

  log.info(
    { watchId, sessionId, durationSeconds, intervalSeconds, mode },
    "Ride shotgun session started",
  );
}

export async function handleRideShotgunStop(
  msg: RideShotgunStop,
  _ctx: HandlerContext,
): Promise<void> {
  const { watchId } = msg;
  const session = watchSessions.get(watchId);
  if (!session) {
    log.warn({ watchId }, "ride_shotgun_stop: session not found");
    return;
  }
  log.info({ watchId, sessionId: session.sessionId }, "Early stop requested");
  await completeSession(session);
}

/**
 * Stop network recording, extract cookies, build and save the SessionRecording.
 */
async function finalizeLearnRecording(
  watchId: string,
  session: WatchSession,
  recordingId: string,
): Promise<string | undefined> {
  try {
    const recorder = activeRecorders.get(watchId);

    // Extract cookies before stopping (needs the CDP connection alive)
    const cookies = recorder
      ? await recorder.extractCookies(session.targetDomain)
      : [];

    const networkEntries = recorder ? await recorder.stop() : [];
    activeRecorders.delete(watchId);

    // Save cookies to the encrypted credential store (keyed by target domain)
    // so they don't need to be persisted in the plaintext recording file.
    if (session.targetDomain && cookies.length > 0) {
      const { setSecureKeyAsync } = await import("../security/secure-keys.js");
      const { upsertCredentialMetadata } =
        await import("../tools/credentials/metadata-store.js");

      const service = session.targetDomain;
      const field = "session:cookies";
      const storageKey = `credential:${service}:${field}`;
      const stored = await setSecureKeyAsync(
        storageKey,
        JSON.stringify(cookies),
      );
      if (stored) {
        try {
          upsertCredentialMetadata(service, field, {});
        } catch {
          // Non-critical: metadata upsert is best-effort
        }
        log.info(
          { targetDomain: service, cookieCount: cookies.length },
          "Cookies saved to credential store",
        );
      } else {
        log.warn(
          { targetDomain: service },
          "Failed to save cookies to credential store",
        );
      }
    }

    const recording: SessionRecording = {
      id: recordingId,
      startedAt: session.startedAt,
      endedAt: Date.now(),
      targetDomain: session.targetDomain,
      networkEntries,
      cookies: [], // Cookies saved to credential store — never persisted in recording
      observations: session.observations.map((obs) => ({
        ocrText: obs.ocrText,
        appName: obs.appName,
        windowTitle: obs.windowTitle,
        timestamp: obs.timestamp,
        captureIndex: obs.captureIndex,
      })),
    };

    const path = saveRecording(recording);
    log.info(
      {
        recordingId,
        networkEntries: networkEntries.length,
        cookies: cookies.length,
        observations: session.observations.length,
      },
      "Learn recording finalized and saved",
    );
    return path;
  } catch (err) {
    log.error(
      { err, watchId, recordingId },
      "Failed to finalize learn recording",
    );
    return undefined;
  }
}
