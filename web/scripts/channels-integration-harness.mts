import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";

import {
  approveTelegramContact,
  blockTelegramContact,
  connectTelegramChannel,
  disconnectTelegramChannel,
  getTelegramChannelAccountForAssistant,
  handleTelegramWebhook,
  listTelegramContacts,
  notifyApprovedTelegramContact,
} from "@/lib/channels/service";
import { getChatMessages, getDb } from "@/lib/db";

const TELEGRAM_SECRET_HEADER = ["x", "telegram", "bot", "api", "sec", "ret", "token"].join(
  "-"
);
const TELEGRAM_API_HOST = "api.telegram.org";
const ANTHROPIC_API_HOST = "api.anthropic.com";
const HARNESS_BOT_TOKEN = "harness-bot-token";

type TelegramMethod = "getMe" | "setWebhook" | "sendMessage" | "deleteWebhook";

type TelegramCall = {
  method: TelegramMethod;
  token: string;
  body: Record<string, unknown>;
};

function parseTelegramApiRequest(urlString: string): {
  method: TelegramMethod;
  token: string;
} | null {
  try {
    const url = new URL(urlString);
    if (url.hostname !== TELEGRAM_API_HOST) {
      return null;
    }

    const match = url.pathname.match(/^\/bot([^/]+)\/(getMe|setWebhook|sendMessage|deleteWebhook)$/);
    if (!match) {
      return null;
    }

    return {
      token: match[1],
      method: match[2] as TelegramMethod,
    };
  } catch {
    return null;
  }
}

function parseBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (!body) {
    return {};
  }
  if (typeof body === "string") {
    return JSON.parse(body) as Record<string, unknown>;
  }
  if (body instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  }
  if (body instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(body))) as Record<string, unknown>;
  }
  throw new Error("Expected JSON string request body in Telegram API mock");
}

function buildTelegramDmPayload(params: {
  messageId: number;
  text: string;
  chatId?: number;
  fromId?: number;
  username?: string;
  firstName?: string;
  lastName?: string;
}): Record<string, unknown> {
  const chatId = params.chatId ?? 9001;
  const fromId = params.fromId ?? chatId;
  const username = params.username ?? `harness-user-${chatId}`;

  return {
    update_id: chatId * 10000 + params.messageId,
    message: {
      message_id: params.messageId,
      text: params.text,
      chat: {
        id: chatId,
        type: "private",
      },
      from: {
        id: fromId,
        username,
        first_name: params.firstName ?? "Harness",
        last_name: params.lastName ?? "User",
      },
    },
  };
}

async function assertRequiredTables(sql: Sql) {
  const required = [
    "assistants",
    "chat_messages",
    "assistant_channel_accounts",
    "assistant_channel_contacts",
  ];

  for (const table of required) {
    const result = await sql`
      SELECT to_regclass(${`public.${table}`}) AS table_name
    `;
    if (!result[0]?.table_name) {
      throw new Error(
        `Missing required table "${table}". Run "bun run db:push" in /web first.`
      );
    }
  }
}

function countTelegramMethods(calls: TelegramCall[]): Map<TelegramMethod, number> {
  const counts = new Map<TelegramMethod, number>();
  for (const call of calls) {
    counts.set(call.method, (counts.get(call.method) ?? 0) + 1);
  }
  return counts;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to run the integration harness");
  }
  if (!process.env.APP_URL) {
    process.env.APP_URL = "http://localhost:3000";
  }

  const sql = getDb() as unknown as Sql;
  await assertRequiredTables(sql);

  const originalFetch = globalThis.fetch;
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = `harness-${randomUUID()}`;

  const telegramCalls: TelegramCall[] = [];
  let anthropicCalls = 0;
  let anthropicFirstRoleViolations = 0;
  let failNextTelegramDeleteWebhook = false;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsedUrl = new URL(url);

    if (
      parsedUrl.hostname === ANTHROPIC_API_HOST &&
      parsedUrl.pathname === "/v1/messages"
    ) {
      const body = parseBody(init?.body);
      anthropicCalls += 1;

      const messages = Array.isArray(body.messages) ? body.messages : [];
      const firstRole =
        messages.length > 0 && typeof messages[0] === "object" && messages[0]
          ? (messages[0] as { role?: unknown }).role
          : null;

      if (firstRole !== "user") {
        anthropicFirstRoleViolations += 1;
        return Response.json(
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "messages: first message must use the \"user\" role",
            },
          },
          { status: 400 }
        );
      }

      return Response.json({
        id: `msg_harness_${anthropicCalls}`,
        type: "message",
        role: "assistant",
        model: typeof body.model === "string" ? body.model : "claude-opus-4-6",
        content: [
          {
            type: "text",
            text: "Harness AI response",
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 64,
          output_tokens: 16,
        },
      });
    }

    const parsed = parseTelegramApiRequest(url);
    if (!parsed) {
      return originalFetch(input, init);
    }

    const body = parseBody(init?.body);
    telegramCalls.push({
      method: parsed.method,
      token: parsed.token,
      body,
    });

    switch (parsed.method) {
      case "getMe":
        return Response.json({
          ok: true,
          result: {
            id: 777001,
            username: "harness_bot",
          },
        });
      case "setWebhook":
        return Response.json({
          ok: true,
          result: true,
        });
      case "sendMessage":
        return Response.json({
          ok: true,
          result: {
            message_id: Number(body.message_id ?? 1),
          },
        });
      case "deleteWebhook":
        if (failNextTelegramDeleteWebhook) {
          failNextTelegramDeleteWebhook = false;
          return Response.json({
            ok: false,
            description: "deleteWebhook failed in harness",
          });
        }
        return Response.json({
          ok: true,
          result: true,
        });
      default:
        throw new Error(`Unexpected Telegram method ${(parsed as { method: string }).method}`);
    }
  };

  const assistantId = randomUUID();
  try {
    await sql`
      INSERT INTO assistants (id, name, description, created_by)
      VALUES (
        ${assistantId},
        ${"Telegram Integration Harness"},
        ${"Temporary assistant created by channels integration harness"},
        ${"integration-harness"}
      )
    `;

    const connectResult = await connectTelegramChannel({
      assistantId,
      botToken: HARNESS_BOT_TOKEN,
      enabled: true,
    });
    assert.equal(connectResult.status, "active");
    assert.equal(connectResult.enabled, true);

    const account = await getTelegramChannelAccountForAssistant(assistantId);
    assert(account, "Expected Telegram channel account to exist after connect");

    const accountConfig = (account.config ?? {}) as Record<string, unknown>;
    const webhookSecret =
      typeof accountConfig.webhookSecret === "string" ? accountConfig.webhookSecret : null;
    assert(webhookSecret, "Expected webhook secret to be stored in channel config");

    const pendingResult = await handleTelegramWebhook({
      channelAccountId: account.id,
      headers: new Headers({ [TELEGRAM_SECRET_HEADER]: webhookSecret }),
      payload: buildTelegramDmPayload({
        messageId: 1001,
        text: "Hello from Telegram",
        chatId: 9001,
      }),
    });
    assert.equal(pendingResult.status, "pending_approval");

    const pendingContacts = await listTelegramContacts({
      assistantId,
      status: "pending",
    });
    assert.equal(pendingContacts.length, 1);
    const firstContact = pendingContacts[0];

    const pairingPromptCall = telegramCalls.find(
      (call) =>
        call.method === "sendMessage" &&
        typeof call.body.text === "string" &&
        call.body.text.includes("private")
    );
    assert(pairingPromptCall, "Expected pairing prompt to be sent for pending contact");

    await approveTelegramContact(assistantId, firstContact.id);
    await notifyApprovedTelegramContact({
      assistantId,
      contactId: firstContact.id,
    });

    const approvedContacts = await listTelegramContacts({
      assistantId,
      status: "approved",
    });
    assert.equal(approvedContacts.length, 1);

    // Seed with an assistant-first message to validate Anthropic first-user handling.
    await sql`
      INSERT INTO chat_messages (
        assistant_id,
        role,
        content,
        status,
        source_channel
      )
      VALUES (
        ${assistantId},
        'assistant',
        ${"Seed greeting from harness"},
        'delivered',
        'web'
      )
    `;

    const okResult = await handleTelegramWebhook({
      channelAccountId: account.id,
      headers: new Headers({ [TELEGRAM_SECRET_HEADER]: webhookSecret }),
      payload: buildTelegramDmPayload({
        messageId: 1002,
        text: "Can you help me with a task list?",
        chatId: 9001,
      }),
    });
    assert.equal(okResult.status, "ok");

    const afterReplyMessages = await getChatMessages(assistantId);
    assert.equal(afterReplyMessages.length, 3);
    const userTelegramMessage = afterReplyMessages.find(
      (message) => message.role === "user" && message.externalMessageId === "1002"
    );
    const assistantTelegramMessage = afterReplyMessages.find(
      (message) =>
        message.role === "assistant" &&
        message.sourceChannel === "telegram" &&
        message.content === "Harness AI response"
    );
    assert(userTelegramMessage, "Expected persisted user telegram message");
    assert(assistantTelegramMessage, "Expected persisted assistant telegram response");
    assert.equal(userTelegramMessage.sourceChannel, "telegram");
    assert.equal(assistantTelegramMessage.sourceChannel, "telegram");

    const secondPendingResult = await handleTelegramWebhook({
      channelAccountId: account.id,
      headers: new Headers({ [TELEGRAM_SECRET_HEADER]: webhookSecret }),
      payload: buildTelegramDmPayload({
        messageId: 1001,
        text: "I am another Telegram user.",
        chatId: 9002,
        firstName: "Second",
      }),
    });
    assert.equal(secondPendingResult.status, "pending_approval");

    const secondPendingContacts = await listTelegramContacts({
      assistantId,
      status: "pending",
    });
    assert.equal(secondPendingContacts.length, 1);
    const secondContact = secondPendingContacts[0];

    await approveTelegramContact(assistantId, secondContact.id);
    await notifyApprovedTelegramContact({
      assistantId,
      contactId: secondContact.id,
    });

    const sameMessageIdOtherChatResult = await handleTelegramWebhook({
      channelAccountId: account.id,
      headers: new Headers({ [TELEGRAM_SECRET_HEADER]: webhookSecret }),
      payload: buildTelegramDmPayload({
        messageId: 1002,
        text: "Same message id as first chat, but different chat.",
        chatId: 9002,
        firstName: "Second",
      }),
    });
    assert.equal(sameMessageIdOtherChatResult.status, "ok");

    const afterSecondChatMessages = await getChatMessages(assistantId);
    assert.equal(afterSecondChatMessages.length, 5);

    const duplicateResult = await handleTelegramWebhook({
      channelAccountId: account.id,
      headers: new Headers({ [TELEGRAM_SECRET_HEADER]: webhookSecret }),
      payload: buildTelegramDmPayload({
        messageId: 1002,
        text: "duplicate message id should dedupe",
        chatId: 9001,
      }),
    });
    assert.equal(duplicateResult.status, "ignored");
    assert.equal(
      (duplicateResult as { reason?: string }).reason,
      "duplicate_message"
    );

    const afterDuplicateMessages = await getChatMessages(assistantId);
    assert.equal(afterDuplicateMessages.length, 5);

    await blockTelegramContact(assistantId, firstContact.id);
    const blockedResult = await handleTelegramWebhook({
      channelAccountId: account.id,
      headers: new Headers({ [TELEGRAM_SECRET_HEADER]: webhookSecret }),
      payload: buildTelegramDmPayload({
        messageId: 1003,
        text: "This should be ignored because contact is blocked",
        chatId: 9001,
      }),
    });
    assert.equal(blockedResult.status, "ignored");
    assert.equal((blockedResult as { reason?: string }).reason, "blocked_contact");

    const wrongSecretResult = await handleTelegramWebhook({
      channelAccountId: account.id,
      headers: new Headers({ [TELEGRAM_SECRET_HEADER]: "incorrect-secret" }),
      payload: buildTelegramDmPayload({
        messageId: 1004,
        text: "This should fail webhook verification",
        chatId: 9001,
      }),
    });
    assert.equal(wrongSecretResult.status, "ignored");
    assert.equal((wrongSecretResult as { reason?: string }).reason, "invalid_secret");

    failNextTelegramDeleteWebhook = true;
    const disconnectResult = await disconnectTelegramChannel(assistantId);
    assert.equal(disconnectResult.success, true);
    assert(
      "warning" in disconnectResult && typeof disconnectResult.warning === "string",
      "Expected disconnect warning when webhook deletion fails"
    );

    const disconnectedAccount = await getTelegramChannelAccountForAssistant(assistantId);
    assert(disconnectedAccount, "Expected account to remain after disconnect");
    assert.equal(disconnectedAccount.enabled, false);
    assert.equal(disconnectedAccount.status, "inactive");
    assert.equal(typeof disconnectedAccount.last_error, "string");

    const disconnectedConfig = (disconnectedAccount.config ?? {}) as Record<string, unknown>;
    assert.equal(disconnectedConfig.botToken ?? null, null);
    assert.equal(disconnectedConfig.webhookSecret ?? null, null);
    assert.equal(disconnectedConfig.webhookUrl ?? null, null);

    const methodCounts = countTelegramMethods(telegramCalls);
    assert((methodCounts.get("getMe") ?? 0) >= 1, "Expected getMe call");
    assert((methodCounts.get("setWebhook") ?? 0) >= 1, "Expected setWebhook call");
    assert((methodCounts.get("sendMessage") ?? 0) >= 3, "Expected sendMessage calls");
    assert((methodCounts.get("deleteWebhook") ?? 0) >= 1, "Expected deleteWebhook call");
    assert(anthropicCalls >= 2, "Expected Anthropic API calls for approved messages");
    assert.equal(
      anthropicFirstRoleViolations,
      0,
      "Expected no Anthropic first-role violations"
    );

    console.log("Telegram integration harness passed.");
    console.log("Telegram API call counts:");
    for (const method of ["getMe", "setWebhook", "sendMessage", "deleteWebhook"] as const) {
      console.log(`- ${method}: ${methodCounts.get(method) ?? 0}`);
    }
    console.log(`- anthropic calls: ${anthropicCalls}`);
  } finally {
    globalThis.fetch = originalFetch;

    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    }

    await sql`DELETE FROM assistants WHERE id = ${assistantId}`;
    await sql.end({ timeout: 1 });
  }
}

main().catch((error) => {
  console.error("Telegram integration harness failed.");
  console.error(error);
  process.exit(1);
});
