import { NextRequest, NextResponse } from "next/server";

// Telegram Bot API types
interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

const VELLY_TELEGRAM_TOKEN = process.env.VELLY_TELEGRAM_TOKEN;
const APP_URL = process.env.APP_URL || "http://localhost:3000";

async function sendTelegramMessage(chatId: number, text: string): Promise<boolean> {
  if (!VELLY_TELEGRAM_TOKEN) {
    console.error("[Telegram] ❌ VELLY_TELEGRAM_TOKEN not configured - cannot send message");
    return false;
  }

  console.log(`[Telegram] 📤 Sending message to chat ${chatId}...`);

  try {
    const response = await fetch(`https://api.telegram.org/bot${VELLY_TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.ok) {
      console.error(`[Telegram] ❌ Failed to send message. Status: ${response.status}`, {
        ok: data.ok,
        error_code: data.error_code,
        description: data.description,
      });
      return false;
    }

    console.log(`[Telegram] ✅ Message sent successfully to chat ${chatId}`);
    return true;
  } catch (error) {
    console.error("[Telegram] ❌ Exception sending message:", error);
    return false;
  }
}

async function getVellumResponse(userMessage: string, username: string): Promise<string> {
  console.log(`[Telegram] 🤖 Getting Vellum response for "${userMessage.substring(0, 50)}..." from ${username}`);

  try {
    const response = await fetch(`${APP_URL}/api/vellum/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: userMessage }],
        username,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Telegram] ❌ Vellum chat API error. Status: ${response.status}`, {
        statusText: response.statusText,
        body: errorText.substring(0, 500),
      });
      return "Sorry, I'm having trouble responding right now. Please try again later.";
    }

    const data = await response.json();
    console.log(`[Telegram] ✅ Vellum response received (${data.content?.length || 0} chars)`);
    return data.content || "I couldn't generate a response.";
  } catch (error) {
    console.error("[Telegram] ❌ Exception getting Vellum response:", error);
    return "Sorry, I encountered an error. Please try again later.";
  }
}

async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message || update.edited_message;

  if (!message?.text) {
    console.log("[Telegram] ⏭️ Skipping update - no text content");
    return;
  }

  const chatId = message.chat.id;
  const text = message.text;
  const username = message.from?.username || message.from?.first_name || "User";

  console.log(`[Telegram] 📩 Processing message from ${username} (chat: ${chatId}): "${text.substring(0, 100)}"`);

  // Get response from Vellum
  const response = await getVellumResponse(text, username);

  // Send response back to Telegram
  const sent = await sendTelegramMessage(chatId, response);

  if (sent) {
    console.log(`[Telegram] ✅ Successfully handled update ${update.update_id}`);
  } else {
    console.error(`[Telegram] ❌ Failed to complete update ${update.update_id} - message not sent`);
  }
}

export async function POST(request: NextRequest) {
  try {
    const update: TelegramUpdate = await request.json();

    console.log("[Telegram Webhook] 📥 Received update:", JSON.stringify(update, null, 2));

    // Process the update and respond
    await handleTelegramUpdate(update).catch((error) => {
      console.error("[Telegram Webhook] ❌ Unhandled error in update handler:", error);
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[Telegram Webhook] ❌ Error parsing request:", error);
    return NextResponse.json({ ok: false, error: "Invalid request" }, { status: 400 });
  }
}

// GET endpoint to verify webhook is set up
export async function GET() {
  return NextResponse.json({
    status: "ok",
    message: "VellumClawBot Telegram webhook endpoint",
    configured: !!VELLY_TELEGRAM_TOKEN,
    appUrl: APP_URL,
  });
}
