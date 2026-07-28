/**
 * Route handlers for the email management API.
 *
 * Delegates to the Vellum platform API for register/unregister/send/list/status/download.
 * All handlers require a valid platform client (UnauthorizedError if not).
 */

import { z } from "zod";

import { markdownToEmailHtml } from "../../email/html-renderer.js";
import { VellumPlatformClient } from "../../platform/client.js";
import { LOCAL_PRINCIPALS } from "../auth/route-policy.js";
import {
  BadRequestError,
  NotFoundError,
  RouteError,
  UnauthorizedError,
} from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Helpers ───────────────────────────────────────────────────────────

async function requireClient(): Promise<VellumPlatformClient> {
  const client = await VellumPlatformClient.create();
  if (!client) {
    throw new UnauthorizedError(
      "Platform credentials not configured. Run: assistant platform connect",
    );
  }
  if (!client.platformAssistantId) {
    throw new UnauthorizedError(
      "Assistant ID not configured. Run: assistant platform connect",
    );
  }
  return client;
}

// ── Handlers ──────────────────────────────────────────────────────────

async function handleEmailRegister({ body = {} }: RouteHandlerArgs) {
  const { username } = body as { username: string };
  const client = await requireClient();

  const response = await client.fetch(
    `/v1/assistants/${client.platformAssistantId}/email-addresses/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    },
  );

  if (!response.ok) {
    const respBody = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const detail =
      respBody.detail ??
      (Array.isArray(respBody.username) ? respBody.username[0] : undefined) ??
      (Array.isArray(respBody.assistant_id)
        ? respBody.assistant_id[0]
        : undefined) ??
      `HTTP ${response.status}`;
    throw new BadRequestError(String(detail));
  }

  const data = (await response.json()) as {
    id: string;
    address: string;
    created_at: string;
  };
  return data;
}

async function handleEmailUnregister(_args: RouteHandlerArgs) {
  const client = await requireClient();

  const listResponse = await client.fetch(
    `/v1/assistants/${client.platformAssistantId}/email-addresses/`,
  );

  if (!listResponse.ok) {
    throw new RouteError(
      `Failed to list email addresses: HTTP ${listResponse.status}`,
      "LIST_FAILED",
      listResponse.status,
    );
  }

  const listData = (await listResponse.json()) as {
    results: { id: string; address: string }[];
  };

  const addresses = listData.results ?? [];
  if (addresses.length === 0) {
    throw new NotFoundError("No email address registered for this assistant.");
  }

  const target = addresses[0];

  const deleteResponse = await client.fetch(
    `/v1/assistants/${client.platformAssistantId}/email-addresses/${target.id}/`,
    { method: "DELETE" },
  );

  if (!deleteResponse.ok) {
    const respBody = (await deleteResponse.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const detail = respBody.detail ?? `HTTP ${deleteResponse.status}`;
    throw new RouteError(
      String(detail),
      "DELETE_FAILED",
      deleteResponse.status,
    );
  }

  return { unregistered: target.address };
}

async function handleEmailStatus(_args: RouteHandlerArgs) {
  const client = await requireClient();

  const listResponse = await client.fetch(
    `/v1/assistants/${client.platformAssistantId}/email-addresses/`,
  );

  if (!listResponse.ok) {
    throw new RouteError(
      `Failed to list email addresses: HTTP ${listResponse.status}`,
      "LIST_FAILED",
      listResponse.status,
    );
  }

  const listData = (await listResponse.json()) as {
    results: { id: string; address: string }[];
  };

  const addresses = listData.results ?? [];
  if (addresses.length === 0) {
    throw new NotFoundError(
      "No email address registered for this assistant. Run: assistant email register <username>",
    );
  }

  const target = addresses[0];

  const statusResponse = await client.fetch(
    `/v1/assistants/${client.platformAssistantId}/email-addresses/${target.id}/status/`,
  );

  if (!statusResponse.ok) {
    const respBody = (await statusResponse.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const detail = respBody.detail ?? `HTTP ${statusResponse.status}`;
    throw new RouteError(
      String(detail),
      "STATUS_FAILED",
      statusResponse.status,
    );
  }

  const statusData = (await statusResponse.json()) as {
    address: string;
    status: string;
    created_at: string;
    usage: {
      sent_today: number;
      daily_limit: number;
      received_today: number;
      sent_this_month: number;
      received_this_month: number;
    };
  };

  return statusData;
}

async function handleEmailList({ queryParams = {} }: RouteHandlerArgs) {
  const client = await requireClient();

  const params = new URLSearchParams();
  if (queryParams.direction && queryParams.direction !== "all") {
    params.set("direction", queryParams.direction);
  }
  if (queryParams.limit) {
    params.set("limit", queryParams.limit);
  }
  if (queryParams.since) {
    params.set("since", queryParams.since);
  }

  const qs = params.toString();
  const path = `/v1/assistants/${client.platformAssistantId}/emails/${qs ? `?${qs}` : ""}`;
  const response = await client.fetch(path);

  if (!response.ok) {
    const respBody = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const detail = respBody.detail ?? `HTTP ${response.status}`;
    throw new RouteError(String(detail), "LIST_FAILED", response.status);
  }

  const data = (await response.json()) as {
    results: unknown[];
    count: number;
  };
  return { results: data.results, count: data.count };
}

async function handleEmailDownload({ queryParams = {} }: RouteHandlerArgs) {
  const client = await requireClient();
  const { messageId } = queryParams;

  const response = await client.fetch(
    `/v1/assistants/${client.platformAssistantId}/emails/${messageId}/`,
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new NotFoundError(`Email message not found: ${messageId}`);
    }
    const respBody = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const detail = respBody.detail ?? `HTTP ${response.status}`;
    throw new RouteError(String(detail), "DOWNLOAD_FAILED", response.status);
  }

  const msg = await response.json();
  return msg;
}

async function handleEmailSend({ body = {} }: RouteHandlerArgs) {
  const { to, text, subject, html, cc, bcc, attachments, reply_to } = body as {
    to: string[];
    text: string;
    subject?: string;
    html?: string;
    cc?: string[];
    bcc?: string[];
    attachments?: {
      filename: string;
      content_type: string;
      content: string;
    }[];
    reply_to?: string;
  };

  const client = await requireClient();

  // Resolve "from" address
  const listResponse = await client.fetch(
    `/v1/assistants/${client.platformAssistantId}/email-addresses/`,
  );

  if (!listResponse.ok) {
    throw new RouteError(
      `Failed to list email addresses: HTTP ${listResponse.status}`,
      "LIST_FAILED",
      listResponse.status,
    );
  }

  const listData = (await listResponse.json()) as {
    results: { id: string; address: string }[];
  };

  const addresses = listData.results ?? [];
  if (addresses.length === 0) {
    throw new NotFoundError(
      "No email address registered for this assistant. Run: assistant email register <username>",
    );
  }

  const fromAddress = addresses[0].address;

  // LLMs often produce literal "\n" escape sequences instead of real newlines.
  const normalizedText = text?.replace(/\\n/g, "\n") ?? "";

  // Auto-generate HTML from text if not provided
  const resolvedHtml = html ?? markdownToEmailHtml(normalizedText);

  const payload: Record<string, unknown> = {
    to,
    from_address: fromAddress,
    text: normalizedText,
  };
  if (subject) payload.subject = subject;
  if (resolvedHtml) payload.html = resolvedHtml;
  if (cc && cc.length > 0) payload.cc = cc;
  if (bcc && bcc.length > 0) payload.bcc = bcc;
  if (attachments && attachments.length > 0) payload.attachments = attachments;
  if (reply_to) payload.reply_to = reply_to;

  const response = await client.fetch("/v1/runtime-proxy/email/send/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    if (response.status === 402) {
      throw new RouteError(
        "Insufficient balance to send email. Add credits at https://platform.vellum.ai/billing",
        "PAYMENT_REQUIRED",
        402,
      );
    }
    const respBody = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const detail = respBody.detail ?? `HTTP ${response.status}`;
    throw new BadRequestError(String(detail));
  }

  const data = (await response.json()) as {
    delivery_id: string;
    status: string;
  };
  return data;
}

// ── Attachment handlers ───────────────────────────────────────────────

interface AttachmentMeta {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  content_id: string;
  created_at: string;
}

async function handleEmailAttachmentList({
  queryParams = {},
}: RouteHandlerArgs) {
  const client = await requireClient();
  const { messageId } = queryParams;

  const response = await client.fetch(
    `/v1/assistants/${client.platformAssistantId}/emails/${messageId}/attachments/`,
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new NotFoundError(`Email message not found: ${messageId}`);
    }
    const respBody = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const detail = respBody.detail ?? `HTTP ${response.status}`;
    throw new RouteError(String(detail), "LIST_FAILED", response.status);
  }

  const data = (await response.json()) as { results: AttachmentMeta[] };
  return { results: data.results ?? [] };
}

async function handleEmailAttachmentGet({
  queryParams = {},
}: RouteHandlerArgs) {
  const client = await requireClient();
  const { messageId, attachmentId } = queryParams;

  const response = await client.fetch(
    `/v1/assistants/${client.platformAssistantId}/emails/${messageId}/attachments/${attachmentId}/download/`,
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new NotFoundError(`Attachment not found: ${attachmentId}`);
    }
    const respBody = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const detail = respBody.detail ?? `HTTP ${response.status}`;
    throw new RouteError(String(detail), "DOWNLOAD_FAILED", response.status);
  }

  if (!response.body) {
    throw new RouteError(
      "Empty response body from download endpoint.",
      "EMPTY_BODY",
      502,
    );
  }

  // Extract filename from content-disposition header, falling back to attachmentId
  const contentDisposition = response.headers.get("content-disposition") ?? "";
  const filenameMatch = contentDisposition.match(
    /filename\*?=['"]?([^'";]+)['"]?/i,
  );
  const filename = filenameMatch?.[1]?.trim() ?? attachmentId;

  const contentType =
    response.headers.get("content-type") ?? "application/octet-stream";

  // Return a streaming response — the IPC server pipes the ReadableStream as
  // chunked binary frames to the client
  return {
    stream: response.body as ReadableStream<Uint8Array>,
    headers: {
      "content-type": contentType,
      "transfer-encoding": "chunked",
      "x-filename": filename,
    },
  };
}

// ── Routes ────────────────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "email_register",
    endpoint: "email/register",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailRegister,
    summary: "Register an email address",
    description:
      "Register a new email address on the Vellum platform for the current assistant.",
    tags: ["email"],
    requestBody: z.object({
      username: z
        .string()
        .min(1)
        .describe("The local part of the email address"),
    }),
    responseBody: z.object({
      id: z.string(),
      address: z.string(),
      created_at: z.string(),
    }),
  },
  {
    operationId: "email_unregister",
    endpoint: "email/unregister",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailUnregister,
    summary: "Unregister the email address",
    description:
      "Remove the email address currently registered for this assistant.",
    tags: ["email"],
    responseBody: z.object({
      unregistered: z.string(),
    }),
  },
  {
    operationId: "email_status",
    endpoint: "email/status",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailStatus,
    summary: "Get email address status and usage",
    description:
      "Show the email address registered for this assistant along with current usage and quota information.",
    tags: ["email"],
    responseBody: z.object({
      address: z.string(),
      status: z.string(),
      created_at: z.string(),
      usage: z.object({
        sent_today: z.number(),
        daily_limit: z.number(),
        received_today: z.number(),
        sent_this_month: z.number(),
        received_this_month: z.number(),
      }),
    }),
  },
  {
    operationId: "email_list",
    endpoint: "email/list",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailList,
    summary: "List email messages",
    description:
      "List received and sent emails for this assistant, with optional filtering.",
    tags: ["email"],
    queryParams: [
      {
        name: "direction",
        type: "string",
        required: false,
        description: "Filter by direction: inbound, outbound, or all",
      },
      {
        name: "limit",
        type: "string",
        required: false,
        description: "Maximum number of results",
      },
      {
        name: "since",
        type: "string",
        required: false,
        description: "Only show messages since this date (ISO 8601)",
      },
    ],
    responseBody: z.object({
      results: z.array(z.unknown()),
      count: z.number(),
    }),
  },
  {
    operationId: "email_download",
    endpoint: "email/download",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailDownload,
    summary: "Download a specific email message",
    description: "Download a specific email message by ID.",
    tags: ["email"],
    queryParams: [
      {
        name: "messageId",
        type: "string",
        required: true,
        description: "Email message ID",
      },
    ],
    responseBody: z.unknown(),
  },
  {
    operationId: "email_send",
    endpoint: "email/send",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailSend,
    summary: "Send an email",
    description:
      "Send an email from the assistant's registered email address via the Vellum runtime proxy.",
    tags: ["email"],
    requestBody: z.object({
      to: z.array(z.string()).min(1).describe("Recipient email address(es)"),
      text: z.string().min(1).describe("Email body (plain text)"),
      subject: z.string().optional().describe("Subject line"),
      html: z
        .string()
        .optional()
        .describe("HTML body (auto-generated from text if omitted)"),
      cc: z.array(z.string()).optional().describe("CC recipients"),
      bcc: z.array(z.string()).optional().describe("BCC recipients"),
      attachments: z
        .array(
          z.object({
            filename: z.string(),
            content_type: z.string(),
            content: z.string().describe("Base64-encoded file content"),
          }),
        )
        .optional()
        .describe("File attachments"),
      reply_to: z.string().optional().describe("Reply-to email ID"),
    }),
    responseBody: z.object({
      delivery_id: z.string(),
      status: z.string(),
    }),
  },
  {
    operationId: "email_attachment_list",
    endpoint: "email/attachment-list",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailAttachmentList,
    summary: "List attachments for an email message",
    description:
      "Return attachment metadata (id, filename, content_type, size_bytes, content_id, created_at) for all attachments on a given email message.",
    tags: ["email"],
    queryParams: [
      {
        name: "messageId",
        type: "string",
        required: true,
        description: "Email message ID",
      },
    ],
    responseBody: z.object({
      results: z.array(
        z.object({
          id: z.string(),
          filename: z.string(),
          content_type: z.string(),
          size_bytes: z.number(),
          content_id: z.string(),
          created_at: z.string(),
        }),
      ),
    }),
  },
  {
    operationId: "email_attachment_get",
    endpoint: "email/attachment-get",
    method: "GET",
    policy: {
      requiredScopes: ["settings.read"],
      allowedPrincipalTypes: LOCAL_PRINCIPALS,
    },
    handler: handleEmailAttachmentGet,
    summary: "Stream-download an email attachment",
    description:
      "Download the binary content of a specific email attachment as a chunked stream. Response headers include content-type from the upstream and x-filename derived from content-disposition.",
    tags: ["email"],
    queryParams: [
      {
        name: "messageId",
        type: "string",
        required: true,
        description: "Email message ID",
      },
      {
        name: "attachmentId",
        type: "string",
        required: true,
        description: "Attachment ID",
      },
    ],
  },
];
