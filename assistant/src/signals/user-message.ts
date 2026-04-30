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

import { getOrCreateConversation } from "../daemon/conversation-store.js";
import type { UserMessageAttachment } from "../daemon/message-types/shared.js";
import {
  processMessageInBackground,
  resolveTurnChannel,
  resolveTurnInterface,
} from "../daemon/process-message.js";
import {
  uploadFileBackedAttachment,
  validateAttachmentUpload,
} from "../memory/attachments-store.js";
import { getOrCreateConversation as getOrCreateConversationKey } from "../memory/conversation-key-store.js";
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
  const resolvedAttachments: UserMessageAttachment[] = [];
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
        resolvedAttachments.push({
          id: stored.id,
          filename: a.filename,
          mimeType: a.mimeType,
          data: "",
          filePath: a.path,
        });
      } catch (err) {
        log.warn({ err, path: a.path }, "Failed to register signal attachment");
      }
    }
  }

  if (conversation.isProcessing()) {
    for (let i = resolvedAttachments.length - 1; i >= 0; i--) {
      const att = resolvedAttachments[i];
      if (att.filePath && !att.data) {
        try {
          att.data = readFileSync(att.filePath).toString("base64");
        } catch (err) {
          log.warn(
            { err, path: att.filePath },
            "Failed to read queued signal attachment, skipping",
          );
          resolvedAttachments.splice(i, 1);
        }
      }
    }
    const requestId = crypto.randomUUID();
    const resolvedChannel = resolveTurnChannel(params.sourceChannel);
    const resolvedInterface = resolveTurnInterface(params.sourceInterface);
    const result = conversation.enqueueMessage(
      params.content,
      resolvedAttachments,
      undefined,
      requestId,
      undefined,
      undefined,
      {
        userMessageChannel: resolvedChannel,
        assistantMessageChannel: resolvedChannel,
        userMessageInterface: resolvedInterface,
        assistantMessageInterface: resolvedInterface,
      },
    );
    return { accepted: !result.rejected };
  }

  await processMessageInBackground(
    conversationId,
    params.content,
    attachmentIds.length > 0 ? attachmentIds : undefined,
    undefined,
    params.sourceChannel,
    params.sourceInterface,
  );
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
