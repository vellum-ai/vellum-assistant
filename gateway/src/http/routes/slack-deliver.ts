import type { GatewayConfig } from "../../config.js";
import type { ConfigFileCache } from "../../config-file-cache.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { checkDeliverAuth } from "../middleware/deliver-auth.js";
import {
  downloadAttachment,
  type RuntimeAttachmentMeta,
} from "../../runtime/client.js";
import { classifySlackError, getUserMessage } from "../../slack/errors.js";
import { approvalPrompt, type Block } from "../../slack/block-kit-builder.js";
import { textToBlocks } from "../../slack/text-to-blocks.js";

const log = getLogger("slack-deliver");
const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RETRY_AFTER_S = 1;

type SlackApiResult = {
  ok: boolean;
  error?: string;
  ts?: string;
};

/**
 * Call a Slack API method with rate-limit retries. Returns the parsed
 * JSON body on success, or a ready-made error Response on failure.
 */
async function callSlackApiWithRetries(
  url: string,
  slackBody: Record<string, unknown>,
  botToken: string,
  chatId: string,
  tlog: Pick<ReturnType<typeof getLogger>, "error" | "warn" | "info">,
): Promise<SlackApiResult | Response> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(slackBody),
    });

    // Handle HTTP-level 429 rate limits
    if (response.status === 429) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        tlog.error({ chatId }, "Slack rate limit exceeded after retries");
        return Response.json({ error: "Rate limited" }, { status: 429 });
      }
      const retryAfter =
        parseInt(response.headers.get("Retry-After") ?? "", 10) ||
        DEFAULT_RETRY_AFTER_S;
      tlog.warn(
        { chatId, retryAfter, attempt },
        "Slack rate limited, retrying",
      );
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    // Handle 5xx server errors with retry
    if (response.status >= 500) {
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        tlog.error(
          { chatId, status: response.status },
          "Slack 5xx error after retries",
        );
        return Response.json({ error: "Delivery failed" }, { status: 502 });
      }
      tlog.warn(
        { chatId, status: response.status, attempt },
        "Slack 5xx error, retrying",
      );
      await new Promise((r) => setTimeout(r, DEFAULT_RETRY_AFTER_S * 1000));
      continue;
    }

    const data = (await response.json()) as {
      ok?: boolean;
      error?: string;
      ts?: string;
    };

    if (!data.ok) {
      lastError = data.error;
      const category = classifySlackError(data.error);

      // Retry rate-limited responses from the body
      if (category === "rate_limit" && attempt < MAX_RATE_LIMIT_RETRIES) {
        tlog.warn(
          { chatId, slackError: data.error, attempt },
          "Slack rate limited (body), retrying",
        );
        await new Promise((r) => setTimeout(r, DEFAULT_RETRY_AFTER_S * 1000));
        continue;
      }

      tlog.error(
        { chatId, slackError: data.error, category },
        "Slack API returned error",
      );

      const userMessage = getUserMessage(data.error);

      if (category === "rate_limit") {
        return Response.json(
          { error: "Rate limited", ...(userMessage && { userMessage }) },
          { status: 429 },
        );
      }
      if (category === "channel_not_found" || category === "not_found") {
        return Response.json(
          { error: "Channel not found", ...(userMessage && { userMessage }) },
          { status: 404 },
        );
      }
      if (category === "permission") {
        return Response.json(
          { error: "Permission denied", ...(userMessage && { userMessage }) },
          { status: 403 },
        );
      }
      // Auth errors use 502 so downstream retry logic treats them as
      // transient (token rotation, brief credential desync). Permanent
      // auth failures will exhaust retries and be dead-lettered normally.
      return Response.json(
        { error: "Delivery failed", ...(userMessage && { userMessage }) },
        { status: 502 },
      );
    }

    return { ok: true, ts: data.ts };
  }

  tlog.error(
    { chatId, slackError: lastError },
    "Slack delivery failed after retries",
  );
  return Response.json({ error: "Delivery failed" }, { status: 502 });
}

/**
 * Upload a single file to Slack using the files.uploadV2 flow:
 * 1. Get an upload URL via files.getUploadURLExternal
 * 2. POST file content to that URL
 * 3. Complete the upload via files.completeUploadExternal, sharing to the channel
 */
async function uploadFileToSlack(
  botToken: string,
  channelId: string,
  buffer: Buffer,
  filename: string,
  threadTs?: string,
): Promise<void> {
  const token = botToken;

  // Step 1: Get an upload URL
  const urlRes = await fetchImpl(
    "https://slack.com/api/files.getUploadURLExternal",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        filename,
        length: String(buffer.length),
      }),
    },
  );

  const urlData = (await urlRes.json()) as {
    ok?: boolean;
    error?: string;
    upload_url?: string;
    file_id?: string;
  };

  if (!urlData.ok || !urlData.upload_url || !urlData.file_id) {
    throw new Error(
      `files.getUploadURLExternal failed: ${urlData.error ?? "unknown"}`,
    );
  }

  // Step 2: Upload file content to the provided URL
  const uploadRes = await fetchImpl(urlData.upload_url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(buffer),
  });

  if (!uploadRes.ok) {
    throw new Error(
      `File upload to Slack failed with status ${uploadRes.status}`,
    );
  }

  // Step 3: Complete the upload and share to channel
  const completeBody: {
    files: Array<{ id: string; title: string }>;
    channel_id: string;
    thread_ts?: string;
  } = {
    files: [{ id: urlData.file_id, title: filename }],
    channel_id: channelId,
  };
  if (threadTs) {
    completeBody.thread_ts = threadTs;
  }

  const completeRes = await fetchImpl(
    "https://slack.com/api/files.completeUploadExternal",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(completeBody),
    },
  );

  const completeData = (await completeRes.json()) as {
    ok?: boolean;
    error?: string;
  };

  if (!completeData.ok) {
    throw new Error(
      `files.completeUploadExternal failed: ${completeData.error ?? "unknown"}`,
    );
  }
}

export async function sendSlackAttachments(
  config: GatewayConfig,
  botToken: string,
  channelId: string,
  attachments: RuntimeAttachmentMeta[],
  threadTs?: string,
): Promise<void> {
  const failures: string[] = [];

  for (const meta of attachments) {
    // Skip oversized attachments before downloading when size is known
    if (
      meta.sizeBytes !== undefined &&
      meta.sizeBytes >
        (config.maxAttachmentBytes.slack ?? config.maxAttachmentBytes.default)
    ) {
      log.warn(
        { attachmentId: meta.id, sizeBytes: meta.sizeBytes },
        "Skipping oversized outbound attachment",
      );
      failures.push(meta.filename ?? meta.id);
      continue;
    }

    try {
      const payload = await downloadAttachment(config, meta.id);

      // Hydrate missing metadata from downloaded payload
      const mimeType =
        meta.mimeType ?? payload.mimeType ?? "application/octet-stream";
      const filename = meta.filename ?? payload.filename ?? meta.id;
      const buffer = Buffer.from(payload.data, "base64");
      const sizeBytes = meta.sizeBytes ?? payload.sizeBytes ?? buffer.length;

      // Check size after hydration for ID-only payloads
      if (
        sizeBytes >
        (config.maxAttachmentBytes.slack ?? config.maxAttachmentBytes.default)
      ) {
        log.warn(
          { attachmentId: meta.id, sizeBytes },
          "Skipping oversized outbound attachment (detected after download)",
        );
        failures.push(filename);
        continue;
      }

      await uploadFileToSlack(botToken, channelId, buffer, filename, threadTs);

      log.debug(
        { channelId, attachmentId: meta.id, filename, mimeType },
        "Attachment sent to Slack",
      );
    } catch (err) {
      const displayName = meta.filename ?? meta.id;
      log.error(
        { err, attachmentId: meta.id, filename: displayName },
        "Failed to send attachment to Slack",
      );
      failures.push(displayName);
    }
  }

  // Send a text fallback for any attachments that failed
  if (failures.length > 0) {
    const notice = `${failures.length} attachment(s) could not be delivered: ${failures.join(", ")}`;
    try {
      const slackBody: Record<string, string> = {
        channel: channelId,
        text: notice,
      };
      if (threadTs) {
        slackBody.thread_ts = threadTs;
      }
      await fetchImpl("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${botToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(slackBody),
      });
    } catch (err) {
      log.error({ err, channelId }, "Failed to send attachment failure notice");
    }
  }
}

export function createSlackDeliverHandler(
  config: GatewayConfig,
  onThreadReply?: (threadTs: string) => void,
  caches?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
  pendingApprovalReplacements?: Map<
    string,
    { messageTs: string; expiresAt: number }
  >,
) {
  return async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const isBypassed =
      process.env.APP_VERSION === "0.0.0-dev" &&
      (caches?.configFile?.getBoolean("slack", "deliverAuthBypass") ?? false);
    const authResponse = checkDeliverAuth(req, isBypassed);
    if (authResponse) return authResponse;

    // Resolve bot token from cache
    let botToken = caches?.credentials
      ? await caches.credentials.get(
          credentialKey("slack_channel", "bot_token"),
        )
      : undefined;

    // One-shot force retry: if token is missing and caches are available,
    // force-refresh and retry once.
    if (!botToken && caches?.credentials) {
      botToken = await caches.credentials.get(
        credentialKey("slack_channel", "bot_token"),
        { force: true },
      );
      if (botToken) {
        tlog.info("Slack bot token resolved after forced credential refresh");
      }
    }

    if (!botToken) {
      tlog.error("Slack bot token not configured");
      return Response.json(
        { error: "Slack integration not configured" },
        { status: 503 },
      );
    }

    let body: {
      chatId?: string;
      to?: string;
      text?: string;
      blocks?: Block[];
      assistantId?: string;
      attachments?: RuntimeAttachmentMeta[];
      ephemeral?: boolean;
      user?: string;
      chatAction?: "typing";
      /** Add or remove an emoji reaction on a message. */
      reaction?: { action: "add" | "remove"; name: string; messageTs: string };
      /** Set or clear the Slack Assistants API thread status indicator. */
      assistantThreadStatus?: {
        channel: string;
        threadTs: string;
        status: string;
      };
      /** Message timestamp to update instead of posting a new message. */
      updateTs?: string;
      /** When provided, use chat.update to edit an existing message instead of posting a new one. */
      messageTs?: string;
      /** When true, auto-generate Block Kit blocks from text via textToBlocks(). */
      useBlocks?: boolean;
      /** When provided, generate Block Kit approval prompt blocks. */
      approval?: {
        requestId: string;
        actions: Array<{
          id: string;
          label: string;
          style?: "primary" | "danger";
        }>;
        plainTextFallback: string;
      };
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json({ error: "Invalid JSON" }, { status: 400 });
    }

    if (typeof body !== "object" || body === null) {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    const { attachments } = body;

    // Validate attachment array shape
    if (attachments) {
      if (!Array.isArray(attachments)) {
        return Response.json(
          { error: "attachments must be an array" },
          { status: 400 },
        );
      }
      for (const att of attachments) {
        if (att === null || typeof att !== "object" || Array.isArray(att)) {
          return Response.json(
            { error: "each attachment must be an object" },
            { status: 400 },
          );
        }
        if (!att.id || typeof att.id !== "string") {
          return Response.json(
            { error: "each attachment must have an id" },
            { status: 400 },
          );
        }
      }
    }

    const { chatAction, updateTs } = body;

    if (chatAction !== undefined && chatAction !== "typing") {
      return Response.json(
        { error: 'chatAction must be "typing"' },
        { status: 400 },
      );
    }

    // Accept `chatId` as an alias for `to` so runtime channel callbacks work without translation.
    const chatId = body.chatId ?? body.to;

    if (!chatId || typeof chatId !== "string") {
      return Response.json({ error: "chatId is required" }, { status: 400 });
    }

    const { text } = body;

    if (
      !text &&
      !chatAction &&
      !body.reaction &&
      !body.assistantThreadStatus &&
      (!attachments || attachments.length === 0)
    ) {
      return Response.json(
        { error: "text or attachments required" },
        { status: 400 },
      );
    }

    if (text !== undefined && typeof text !== "string") {
      return Response.json({ error: "text must be a string" }, { status: 400 });
    }

    const isEphemeral = body.ephemeral === true;
    if (isEphemeral && (!body.user || typeof body.user !== "string")) {
      return Response.json(
        { error: "user is required for ephemeral messages" },
        { status: 400 },
      );
    }
    if (isEphemeral && attachments && attachments.length > 0) {
      return Response.json(
        { error: "attachments are not supported for ephemeral messages" },
        { status: 400 },
      );
    }

    // Validate approval payload shape
    if (body.approval) {
      const apr = body.approval;
      if (typeof apr !== "object" || apr === null || Array.isArray(apr)) {
        return Response.json(
          { error: "approval must be an object" },
          { status: 400 },
        );
      }
      if (!apr.requestId || typeof apr.requestId !== "string") {
        return Response.json(
          { error: "approval.requestId is required" },
          { status: 400 },
        );
      }
      if (!Array.isArray(apr.actions) || apr.actions.length === 0) {
        return Response.json(
          { error: "approval.actions must be a non-empty array" },
          { status: 400 },
        );
      }
      for (const action of apr.actions) {
        if (
          action === null ||
          typeof action !== "object" ||
          Array.isArray(action)
        ) {
          return Response.json(
            { error: "each approval action must be an object" },
            { status: 400 },
          );
        }
        if (!action.id || typeof action.id !== "string") {
          return Response.json(
            { error: "each approval action must have an id" },
            { status: 400 },
          );
        }
        if (!action.label || typeof action.label !== "string") {
          return Response.json(
            { error: "each approval action must have a label" },
            { status: 400 },
          );
        }
      }
    }

    // Support threading via query param
    const threadTs = new URL(req.url).searchParams.get("threadTs") ?? undefined;
    let messageTs = body.messageTs ?? updateTs;
    let isUpdate = typeof messageTs === "string" && messageTs.length > 0;

    // Check for pending approval message replacement: if this is a new message
    // (not already an update) to a thread with a pending approval replacement,
    // convert it to an update of the approval message so the follow-up content
    // replaces the original approval prompt.
    if (threadTs && !isUpdate && !isEphemeral && !chatAction && text) {
      const replacementKey = `${chatId}:${threadTs}`;
      const pending = pendingApprovalReplacements?.get(replacementKey);
      if (pending) {
        messageTs = pending.messageTs;
        isUpdate = true;
        pendingApprovalReplacements!.delete(replacementKey);
        tlog.info(
          { chatId, threadTs, approvalMessageTs: messageTs },
          "Converting delivery to approval message replacement",
        );
      }
    }

    // Resolve Block Kit blocks: use provided blocks, approval prompt, or auto-format text
    const blocks: Block[] =
      Array.isArray(body.blocks) && body.blocks.length > 0
        ? body.blocks
        : body.approval
          ? approvalPrompt({
              message: text || body.approval.plainTextFallback,
              requestId: body.approval.requestId,
              actions: body.approval.actions,
            })
          : body.useBlocks && text
            ? textToBlocks(text)
            : [];

    tlog.info(
      {
        chatId,
        hasBodyBlocks: Array.isArray(body.blocks) && body.blocks.length > 0,
        bodyBlockCount: Array.isArray(body.blocks) ? body.blocks.length : 0,
        hasApproval: !!body.approval,
        useBlocks: !!body.useBlocks,
        resolvedBlockCount: blocks.length,
        blockSource:
          Array.isArray(body.blocks) && body.blocks.length > 0
            ? "provided"
            : body.approval
              ? "approval"
              : body.useBlocks && text
                ? "textToBlocks"
                : "none",
      },
      "Block Kit resolution",
    );

    try {
      // Emoji reaction: add or remove a reaction on an existing message.
      // Fire-and-forget — reaction failures are logged but don't fail the request.
      if (body.reaction) {
        const { action, name, messageTs: reactionTs } = body.reaction;
        const method = action === "add" ? "reactions.add" : "reactions.remove";
        const reactionBody = {
          channel: chatId,
          name,
          timestamp: reactionTs,
        };

        try {
          const res = await fetchImpl(`https://slack.com/api/${method}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${botToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(reactionBody),
          });
          const data = (await res.json()) as {
            ok?: boolean;
            error?: string;
          };
          if (!data.ok) {
            // "already_reacted" and "no_reaction" are expected race conditions
            if (
              data.error !== "already_reacted" &&
              data.error !== "no_reaction"
            ) {
              tlog.warn(
                { chatId, method, slackError: data.error },
                "Slack reaction API returned error",
              );
            }
          }
        } catch (err) {
          tlog.warn(
            { err, chatId, method },
            "Failed to deliver Slack reaction",
          );
        }

        return Response.json({ ok: true });
      }

      // Slack Assistants API thread status indicator.
      // Sets or clears the native "is thinking..." status on a thread.
      // Falls back to emoji reactions for installs without `assistant:write` scope.
      if (body.assistantThreadStatus) {
        const {
          channel,
          threadTs: statusThreadTs,
          status,
        } = body.assistantThreadStatus;
        let statusSet = false;
        try {
          const res = await fetchImpl(
            "https://slack.com/api/assistant.threads.setStatus",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${botToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                channel_id: channel,
                thread_ts: statusThreadTs,
                status,
              }),
            },
          );
          const data = (await res.json()) as {
            ok?: boolean;
            error?: string;
          };
          if (data.ok) {
            statusSet = true;
          } else {
            tlog.warn(
              { chatId, slackError: data.error },
              "Slack assistant.threads.setStatus returned error, falling back to reaction",
            );
          }
        } catch (err) {
          tlog.warn(
            { err, chatId },
            "Failed to set Slack assistant thread status, falling back to reaction",
          );
        }

        // Fallback: use eyes reaction when setStatus is unavailable
        // (e.g. missing assistant:write scope on older installs).
        if (!statusSet) {
          const isSet = status.length > 0;
          const method = isSet ? "reactions.add" : "reactions.remove";
          try {
            const res = await fetchImpl(`https://slack.com/api/${method}`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${botToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                channel,
                name: "eyes",
                timestamp: statusThreadTs,
              }),
            });
            const data = (await res.json()) as {
              ok?: boolean;
              error?: string;
            };
            if (
              !data.ok &&
              data.error !== "already_reacted" &&
              data.error !== "no_reaction"
            ) {
              tlog.warn(
                { chatId, method, slackError: data.error },
                "Slack reaction fallback returned error",
              );
            }
          } catch (err) {
            tlog.warn(
              { err, chatId, method },
              "Failed to deliver Slack reaction fallback",
            );
          }
        }

        return Response.json({ ok: true });
      }

      // Typing indicator: post a placeholder message that the runtime can
      // later update via `updateTs` when the real response is ready.
      // Slack bots have no native typing indicator API, so this serves as
      // a lightweight visual cue.
      if (chatAction === "typing") {
        const placeholderBody: Record<string, string> = {
          channel: chatId,
          text: "\u2026",
        };
        if (threadTs) {
          placeholderBody.thread_ts = threadTs;
        }

        const response = await fetchImpl(
          "https://slack.com/api/chat.postMessage",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${botToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(placeholderBody),
          },
        );

        const data = (await response.json()) as {
          ok?: boolean;
          error?: string;
          ts?: string;
        };

        if (!data.ok) {
          tlog.error(
            { chatId, slackError: data.error },
            "Slack API returned error for typing placeholder",
          );
          return Response.json({ error: "Delivery failed" }, { status: 502 });
        }

        tlog.info(
          { chatId, placeholderTs: data.ts, hasThreadTs: !!threadTs },
          "Slack typing placeholder sent",
        );

        if (threadTs && onThreadReply) {
          onThreadReply(threadTs);
        }

        // Return the placeholder message ts so the runtime can update it later
        return Response.json({ ok: true, placeholderTs: data.ts });
      }

      // Track the thread early — before any API call — so replies arriving
      // while the post is in-flight are still forwarded.  A spurious entry
      // if the post ultimately fails is harmless (24h TTL expiry).
      if (threadTs && onThreadReply && !isEphemeral) {
        onThreadReply(threadTs);
      }

      if (text && typeof text === "string") {
        const slackBody: Record<string, unknown> = {
          channel: chatId,
          // `text` is always required as a fallback for notifications and accessibility
          text,
        };

        // Add Block Kit blocks for rich formatting
        if (blocks.length > 0) {
          slackBody.blocks = blocks;
        }

        if (threadTs) {
          slackBody.thread_ts = threadTs;
        }

        // Ephemeral messages are only visible to the target user and cannot be
        // edited or deleted after posting — they are fire-and-forget.
        if (isEphemeral) {
          slackBody.user = body.user!;
        }

        let result: SlackApiResult | Response;

        if (isUpdate) {
          // chat.update only accepts channel, ts, text, and blocks — thread_ts
          // is not a valid parameter and would cause the call to fail silently.
          const updateBody: Record<string, unknown> = {
            channel: chatId,
            text,
            ts: messageTs,
          };
          if (blocks.length > 0) {
            updateBody.blocks = blocks;
          }
          result = await callSlackApiWithRetries(
            "https://slack.com/api/chat.update",
            updateBody,
            botToken,
            chatId,
            tlog,
          );

          // Fall back to posting a new message if update fails
          if (result instanceof Response) {
            tlog.warn(
              { chatId, messageTs },
              "Slack chat.update failed, falling back to chat.postMessage",
            );
            result = await callSlackApiWithRetries(
              "https://slack.com/api/chat.postMessage",
              slackBody,
              botToken,
              chatId,
              tlog,
            );
          }
        } else {
          const slackMethod = isEphemeral
            ? "chat.postEphemeral"
            : "chat.postMessage";

          result = await callSlackApiWithRetries(
            `https://slack.com/api/${slackMethod}`,
            slackBody,
            botToken,
            chatId,
            tlog,
          );
        }

        // If result is a Response, it's an error response — return it directly
        if (result instanceof Response) {
          return result;
        }
      }

      if (attachments && attachments.length > 0) {
        await sendSlackAttachments(
          config,
          botToken,
          chatId,
          attachments,
          threadTs,
        );
      }

      tlog.info(
        {
          chatId,
          hasThreadTs: !!threadTs,
          isUpdate,
          ephemeral: isEphemeral,
          hasText: !!text,
          attachmentCount: attachments?.length ?? 0,
        },
        isUpdate ? "Slack message updated" : "Slack message sent",
      );

      return Response.json({ ok: true });
    } catch (err) {
      tlog.error({ err, chatId }, "Failed to deliver Slack message");
      return Response.json({ error: "Delivery failed" }, { status: 502 });
    }
  };
}
