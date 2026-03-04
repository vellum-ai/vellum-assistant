import type { GatewayConfig } from "../../config.js";
import { fetchImpl } from "../../fetch.js";
import { getLogger } from "../../logger.js";
import { checkDeliverAuth } from "../middleware/deliver-auth.js";
import {
  downloadAttachment,
  type RuntimeAttachmentMeta,
} from "../../runtime/client.js";

const log = getLogger("slack-deliver");

/**
 * Upload a single file to Slack using the files.uploadV2 flow:
 * 1. Get an upload URL via files.getUploadURLExternal
 * 2. POST file content to that URL
 * 3. Complete the upload via files.completeUploadExternal, sharing to the channel
 */
async function uploadFileToSlack(
  config: GatewayConfig,
  channelId: string,
  buffer: Buffer,
  filename: string,
  threadTs?: string,
): Promise<void> {
  const token = config.slackChannelBotToken!;

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
  await fetchImpl(urlData.upload_url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: buffer,
  });

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
  channelId: string,
  attachments: RuntimeAttachmentMeta[],
  threadTs?: string,
): Promise<void> {
  const failures: string[] = [];

  for (const meta of attachments) {
    // Skip oversized attachments before downloading when size is known
    if (
      meta.sizeBytes !== undefined &&
      meta.sizeBytes > config.maxAttachmentBytes
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
      if (sizeBytes > config.maxAttachmentBytes) {
        log.warn(
          { attachmentId: meta.id, sizeBytes },
          "Skipping oversized outbound attachment (detected after download)",
        );
        failures.push(filename);
        continue;
      }

      await uploadFileToSlack(config, channelId, buffer, filename, threadTs);

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
          Authorization: `Bearer ${config.slackChannelBotToken!}`,
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
) {
  return async (req: Request): Promise<Response> => {
    const traceId = req.headers.get("x-trace-id") ?? undefined;
    const tlog = traceId ? log.child({ traceId }) : log;

    if (req.method !== "POST") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }

    const authResponse = checkDeliverAuth(
      req,
      config,
      "slackDeliverAuthBypass",
    );
    if (authResponse) return authResponse;

    if (!config.slackChannelBotToken) {
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
      assistantId?: string;
      attachments?: RuntimeAttachmentMeta[];
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

    // Accept `chatId` as an alias for `to` so runtime channel callbacks work without translation.
    const chatId = body.chatId ?? body.to;

    if (!chatId || typeof chatId !== "string") {
      return Response.json({ error: "chatId is required" }, { status: 400 });
    }

    const { text } = body;

    if (!text && (!attachments || attachments.length === 0)) {
      return Response.json(
        { error: "text or attachments required" },
        { status: 400 },
      );
    }

    // Support threading via query param
    const threadTs = new URL(req.url).searchParams.get("threadTs") ?? undefined;

    try {
      if (text && typeof text === "string") {
        const slackBody: Record<string, string> = {
          channel: chatId,
          text,
        };
        if (threadTs) {
          slackBody.thread_ts = threadTs;
        }

        const response = await fetchImpl(
          "https://slack.com/api/chat.postMessage",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.slackChannelBotToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(slackBody),
          },
        );

        const data = (await response.json()) as {
          ok?: boolean;
          error?: string;
        };

        if (!data.ok) {
          tlog.error(
            { chatId, slackError: data.error },
            "Slack API returned error",
          );
          return Response.json({ error: "Delivery failed" }, { status: 502 });
        }
      }

      if (attachments && attachments.length > 0) {
        await sendSlackAttachments(config, chatId, attachments, threadTs);
      }
    } catch (err) {
      tlog.error({ err, chatId }, "Failed to deliver Slack message");
      return Response.json({ error: "Delivery failed" }, { status: 502 });
    }

    tlog.info(
      {
        chatId,
        hasThreadTs: !!threadTs,
        hasText: !!text,
        attachmentCount: attachments?.length ?? 0,
      },
      "Slack message sent",
    );

    // Track the thread so future replies without @mention are forwarded
    if (threadTs && onThreadReply) {
      onThreadReply(threadTs);
    }

    return Response.json({ ok: true });
  };
}
