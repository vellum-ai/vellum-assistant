/**
 * Handle user-message signals delivered via signal files from the CLI.
 *
 * Each invocation writes JSON to a unique `signals/user-message.<requestId>`
 * file. ConfigWatcher detects the new file and invokes
 * {@link handleUserMessageSignal}, which reads the payload, dispatches
 * the message through the daemon's send pipeline, and writes the result
 * to `signals/user-message.<requestId>.result` for the CLI to pick up.
 *
 * Per-request filenames avoid dropped messages when overlapping invocations
 * race on the same signal file.
 */

import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { v7 as uuidv7 } from "uuid";

import { AdmissionOverflowError } from "../daemon/conversation-admission.js";
import { getOrCreateConversation } from "../daemon/conversation-store.js";
import { submitUserTurn } from "../daemon/conversation-submit.js";
import { processMessageInBackground } from "../daemon/process-message.js";
import {
  uploadFileBackedAttachment,
  validateAttachmentUpload,
} from "../persistence/attachments-store.js";
import { getOrCreateConversation as getOrCreateConversationKey } from "../persistence/conversation-key-store.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import { checkIngressForSecrets } from "../security/secret-ingress.js";
import { getLogger } from "../util/logger.js";
import { getSignalsDir } from "../util/platform.js";

const log = getLogger("signal:user-message");

// ── Attachment descriptor ───────────────────────────────────────────

/** A file-backed attachment included in a signal payload. */
export interface SignalAttachment {
  /** Absolute path to the file on disk. */
  path: string;
  /** Display filename (e.g. "f_0001.jpg"). */
  filename: string;
  /** MIME type (e.g. "image/jpeg"). */
  mimeType: string;
}

// ── Dispatch helper ──────────────────────────────────────────────────

async function dispatchUserMessage(params: {
  conversationKey: string;
  content: string;
  sourceChannel: string;
  sourceInterface: string;
  bypassSecretCheck?: boolean;
  attachments?: SignalAttachment[];
}): Promise<{ accepted: boolean; error?: string; message?: string }> {
  if (!params.bypassSecretCheck) {
    const ingressResult = checkIngressForSecrets(params.content);
    if (ingressResult.blocked) {
      return {
        accepted: false,
        error: "secret_blocked" as const,
        message: ingressResult.userNotice,
      };
    }
  }

  const { conversationId } = getOrCreateConversationKey(params.conversationKey);
  const conversation = await getOrCreateConversation(conversationId);

  const attachmentIds: string[] = [];
  if (params.attachments && params.attachments.length > 0) {
    for (const a of params.attachments) {
      try {
        const validation = validateAttachmentUpload(a.filename, a.mimeType);
        if (!validation.ok) {
          log.warn(
            { error: validation.error, path: a.path },
            "Signal attachment rejected by validation",
          );
          continue;
        }
        const size = statSync(a.path).size;
        const stored = uploadFileBackedAttachment(
          a.filename,
          a.mimeType,
          a.path,
          size,
        );
        attachmentIds.push(stored.id);
      } catch (err) {
        log.warn({ err, path: a.path }, "Failed to register signal attachment");
      }
    }
  }

  // The CLI carries no actor principal, so it is the guardian by the routes
  // layer's convention and always allowed to interrupt. The decision is made
  // before any of the handover is awaited: the CLI stops waiting for the
  // result file after 10 s, and the handover alone can spend the abort budget
  // plus the turn-boundary commit wait.
  try {
    await submitUserTurn(conversation, {
      origin: "signals/user-message",
      onEvent: broadcastMessage,
      requestId: uuidv7(),
      run: async () => {
        await processMessageInBackground(conversationId, params.content, {
          attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
          sourceChannel: params.sourceChannel,
          sourceInterface: params.sourceInterface,
        });
      },
    });
  } catch (err) {
    if (err instanceof AdmissionOverflowError) {
      log.warn(
        { conversationId, pending: err.pending },
        "Refusing a signal send: the conversation already has the maximum number waiting",
      );
      return {
        accepted: false,
        error: "busy" as const,
        message:
          "The assistant already has too many messages waiting. Try again in a moment.",
      };
    }
    throw err;
  }
  return { accepted: true };
}

// ── Signal handler ───────────────────────────────────────────────────

/**
 * Read a `signals/user-message.<requestId>` file and dispatch the message
 * through the daemon's send pipeline. Writes
 * `signals/user-message.<requestId>.result` with the outcome so the CLI
 * can display feedback. Called by ConfigWatcher when a matching signal
 * file is created or modified.
 */
export async function handleUserMessageSignal(filename: string): Promise<void> {
  const signalsDir = getSignalsDir();
  const signalPath = join(signalsDir, filename);
  const resultPath = join(signalsDir, `${filename}.result`);

  const writeResult = (
    data:
      | {
          ok: true;
          accepted: boolean;
          requestId: string;
          error?: string;
          message?: string;
        }
      | { ok: false; error: string; requestId: string | null },
  ): void => {
    try {
      writeFileSync(resultPath, JSON.stringify(data));
    } catch {
      // Best-effort — filesystem may be broken.
    }
  };

  let raw: string;
  try {
    raw = readFileSync(signalPath, "utf-8");
  } catch {
    // File may already be deleted (e.g. re-trigger from our own unlinkSync).
    return;
  }

  try {
    unlinkSync(signalPath);
  } catch {
    // Best-effort cleanup; the file may already be gone.
  }

  let parsedRequestId: string | undefined;

  try {
    const parsed = JSON.parse(raw) as {
      conversationKey?: string;
      content?: string;
      sourceChannel?: string;
      interface?: string;
      requestId?: string;
      bypassSecretCheck?: boolean;
      attachments?: Array<{
        path?: string;
        filename?: string;
        mimeType?: string;
      }>;
    };
    const { requestId } = parsed;
    parsedRequestId = requestId;

    if (!requestId || typeof requestId !== "string") {
      log.warn("User-message signal missing requestId");
      writeResult({ ok: false, error: "Missing requestId", requestId: null });
      return;
    }

    if (!parsed.conversationKey || typeof parsed.conversationKey !== "string") {
      log.warn("User-message signal missing conversationKey");
      writeResult({
        ok: false,
        error: "Missing conversationKey",
        requestId,
      });
      return;
    }

    if (!parsed.content || typeof parsed.content !== "string") {
      log.warn("User-message signal missing content");
      writeResult({ ok: false, error: "Missing content", requestId });
      return;
    }

    // Validate and normalize attachments
    const attachments: SignalAttachment[] = [];
    if (Array.isArray(parsed.attachments)) {
      for (const a of parsed.attachments) {
        if (
          typeof a.path === "string" &&
          typeof a.filename === "string" &&
          typeof a.mimeType === "string"
        ) {
          attachments.push({
            path: a.path,
            filename: a.filename,
            mimeType: a.mimeType,
          });
        }
      }
    }

    const result = await dispatchUserMessage({
      conversationKey: parsed.conversationKey,
      content: parsed.content,
      sourceChannel: parsed.sourceChannel ?? "vellum",
      sourceInterface: parsed.interface ?? "cli",
      bypassSecretCheck: parsed.bypassSecretCheck === true,
      ...(attachments.length > 0 ? { attachments } : {}),
    });

    log.info(
      { accepted: result.accepted },
      "User message dispatched via signal file",
    );
    writeResult({
      ok: true,
      accepted: result.accepted,
      requestId,
      ...(result.error ? { error: result.error } : {}),
      ...(result.message ? { message: result.message } : {}),
    });
  } catch (err) {
    log.error({ err }, "Failed to handle user-message signal");
    writeResult({
      ok: false,
      error: "Internal error",
      requestId: parsedRequestId ?? null,
    });
  }
}
